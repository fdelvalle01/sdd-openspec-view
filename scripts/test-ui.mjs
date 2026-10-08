import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, mkdtemp, cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { scanRoot, readDocument, searchDocuments, searchWarnings } from '../src/model.js';
import { renderMarkdown } from '../src/markdown.js';
import { buildKnowledgeIndex } from '../src/knowledge.js';

// Production UI bundle with a local bridge. Real VS Code configuration and
// file-system watchers are covered separately by tests/host.cjs.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const demo = path.join(root, 'demo');
const out = path.join(root, '.local', 'ui');
const graphBaseline = process.env.SDD_VIEWER_UI_GRAPH_BASELINE === '1';
const graphEvidence = path.join(root, '.local', 'graph-fidelity');
await mkdir(out, { recursive: true });
const demoSnapshot = { ...await scanRoot(demo), demo: true };
let snapshot = structuredClone(demoSnapshot);
let currentDocument = null;
let failingPath = null;
let searchOverride = null;
let currentRoot = demo;
let scanOptions = { pages: {}, selectedChange: null, changePage: 0 };
let failingScope = null;
let holdChange = false;
let currentGraph;
const messages = [], errors = [], requests = [];
const report = { passed: false, browser: 'Microsoft Edge / Playwright', checks: [] };
let browser, page;
const files = new Map(['view.js', 'view.css', 'theme-tokens.css', 'reading-tokens.css'].map(name => [`/${name}`, [path.join(root, 'media', name), name.endsWith('.js') ? 'application/javascript' : 'text/css']]));
if (graphBaseline) for (const name of ['view.js', 'view.css']) files.set(`/${name}`, [path.join(graphEvidence, `before-${name}`), name.endsWith('.js') ? 'application/javascript' : 'text/css']);
for (const font of ['hanken-grotesk-400-700-latin.woff2', 'hanken-grotesk-400-700-latin-ext.woff2', 'jetbrains-mono-400-700-latin.woff2', 'pt-serif-700-latin.woff2']) files.set(`/fonts/${font}`, [path.join(root, 'media/fonts', font), 'font/woff2']);
const nonce = 'local-ui-test-nonce';
const csp = `default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src 'self';`;
const server = createServer(async (request, response) => {
  try {
    if (request.url === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp });
      response.end(`<!doctype html><html lang="es"><head><meta charset="UTF-8"><link rel="stylesheet" href="/theme-tokens.css"><link rel="stylesheet" href="/reading-tokens.css"><link rel="stylesheet" href="/view.css"></head><body class="vscode-dark"><div id="app"></div><script nonce="${nonce}" src="/view.js"></script></body></html>`); return;
    }
    const item = files.get(request.url);
    if (!item) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Content-Type': item[1] }); response.end(await readFile(item[0]));
  } catch { response.writeHead(500); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const lastOf = type => messages.filter(message => message.type === type).at(-1);
const check = async (name, callback) => {
  if (graphBaseline && !/graph measurements|browser reports/.test(name)) return;
  if (process.env.SDD_VIEWER_UI_GRAPH_ONLY && !/knowledge graph|graph map|graph details|graph fidelity|graph motion|graph measurements|browser reports/.test(name)) return;
  if (process.env.SDD_VIEWER_UI_GRAPH_ONLY === 'demo' && /knowledge graph/.test(name)) return;
  try { await callback(); report.checks.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) { report.checks.push({ name, passed: false, error: error.message }); throw error; }
};
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // Paginated filesystem fixtures and graph scans share the CI runner's disk.
  page.setDefaultTimeout(30_000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push(request.url()));
  const deliver = message => page.evaluate(data => {
    window.dispatchEvent(new MessageEvent('message', { data }));
    if (data.type === 'graph') window.__lastGraphResponseId = data.requestId;
  }, message);
  const screenshot = name => page.screenshot({ path: path.join(out, `${name}.png`), animations: 'disabled' });
  const noHorizontalOverflow = async label => {
    const d = await page.evaluate(() => ({ width: innerWidth, html: document.documentElement.scrollWidth, body: document.body.scrollWidth,
      main: [...document.querySelectorAll('.main, .content, .page, .hu-main')].map(n => ({ class: n.className, client: n.clientWidth, scroll: n.scrollWidth })) }));
    assert.ok(d.html <= d.width + 2 && d.body <= d.width + 2, `${label}: overflow ${JSON.stringify(d)}`);
    assert.ok(d.main.every(n => !n.client || n.scroll <= n.client + 2), `${label}: content overflow ${JSON.stringify(d)}`);
  };
  const isActive = locator => locator.evaluate(n => n === document.activeElement);
  const tab = name => page.getByRole('tab', { name });
  const nav = name => page.locator('.explorer').getByRole('button', { name }).first();
  const graphNode = id => page.locator(`.graph-canvas .graph-node[data-graph-key=${JSON.stringify(id.startsWith('zone:') && !graphBaseline ? `visual:${id}` : id)}]`);
  const openGraphList = async () => {
    const panel = page.locator('details.graph-list-panel');
    if (await panel.count() && !(await panel.evaluate(item => item.open))) await panel.locator('summary').click();
  };
  const closeGraphList = async () => {
    const panel = page.locator('details.graph-list-panel');
    if (await panel.count() && await panel.evaluate(item => item.open)) await panel.locator('summary').click();
  };
  const graphCamera = () => page.locator('.graph-view').evaluate(item => ({ zoom: item.dataset.zoom, panX: item.dataset.panX, panY: item.dataset.panY }));
  const toggleGraphArchive = async expected => {
    const previousRequest = lastOf('graph').requestId;
    await page.getByRole('button', { name: 'Incluir archivo', exact: true }).click();
    await page.waitForFunction(previous => window.__lastGraphResponseId !== previous
      && document.querySelector('.graph-view .graph-canvas')
      && document.querySelector('.graph-view')?.dataset.zoom !== undefined, previousRequest);
    assert.equal(lastOf('graph').includeArchive, expected);
    assert.equal(currentGraph.coverage.archive.status === 'excluded', !expected, 'Wait for the replacement index, not the previous canvas.');
    assert.equal(await page.getByRole('button', { name: 'Incluir archivo', exact: true }).getAttribute('aria-pressed'), String(expected));
  };
  const graphPoint = id => graphNode(id).evaluate(item => { const point = new DOMPoint(0, 0).matrixTransform(item.getScreenCTM()); return { x: point.x, y: point.y }; });
  const clickGraphNode = async (id, double = false, delay = 0) => { const point = await graphPoint(id); if (double) await page.mouse.dblclick(point.x, point.y, { delay }); else await page.mouse.click(point.x, point.y); };
  const openCatalog = async () => {
    await page.locator('[data-key="nav:change:catalog-search"]').click();
    await page.waitForFunction(() => window.__viewerState.view === 'change'
      && window.__viewerState.selectedChange === 'catalog-search'
      && document.querySelector('.hu-title')
      && document.querySelector('.view-root')?.getAttribute('aria-busy') === 'false');
  };
  const waitDocument = relative => page.waitForFunction(value => document.querySelector('.doc-meta-path')?.textContent === value, relative);
  const focusTrapped = async dialog => {
    const controls = dialog.locator('button:not([disabled]), input:not([disabled]), [tabindex="0"]');
    await controls.last().focus(); await page.keyboard.press('Tab');
    assert.equal(await dialog.evaluate(n => n.contains(document.activeElement)), true, 'Tab stays inside modal.');
    await controls.first().focus(); await page.keyboard.press('Shift+Tab');
    assert.equal(await dialog.evaluate(n => n.contains(document.activeElement)), true, 'Shift+Tab stays inside modal.');
  };
  await page.exposeFunction('hostMessage', async message => {
    messages.push(message);
    if (['ready', 'refresh', 'demo'].includes(message.type)) {
      await deliver({ type: 'snapshot', snapshot, document: currentDocument });
      if (message.type === 'ready') await deliver({ type: 'settings', readingSize: 15, surfaces: 'personal' });
    } else if (message.type === 'page' || message.type === 'loadChange') {
      assert.equal(message.rootPath, snapshot.rootPath);
      if (message.type === 'page' && message.scope === failingScope) { await deliver({ type: 'loadError', scope: message.scope, message: 'Fallo de página simulado.' }); return; }
      if (message.type === 'loadChange' && holdChange) return;
      if (message.type === 'page') scanOptions.pages[message.scope] = message.page;
      else { scanOptions.selectedChange = message.id; scanOptions.changePage = message.page; }
      snapshot = { ...await scanRoot(currentRoot, scanOptions), demo: currentRoot === demo };
      await deliver({ type: 'snapshot', snapshot, document: currentDocument });
    } else if (message.type === 'read') {
      if (message.path === failingPath) { await deliver({ type: 'error', message: 'El documento supera el límite de lectura de 1 MiB de esta POC.', path: message.path }); return; }
      currentDocument = await readDocument(currentRoot, message.path);
      await deliver({ type: 'document', document: currentDocument });
    } else if (message.type === 'graph') {
      currentGraph = await buildKnowledgeIndex(currentRoot, { includeArchive: message.includeArchive === true, includeInferred: message.includeInferred === true });
      await deliver({ type: 'graph', rootPath: snapshot.rootPath, requestId: message.requestId, index: currentGraph });
    } else if (message.type === 'search') {
      const results = searchOverride || await searchDocuments(currentRoot, snapshot, message.query, message.scope);
      await deliver({ type: 'results', query: message.query, scope: message.scope, requestId: message.requestId, results, warnings: searchOverride ? [] : searchWarnings(snapshot, message.scope) });
    } else if (message.type === 'copyText') await deliver({ type: 'copyResult', ok: true, message: 'Copiado.' });
  });
  await page.addInitScript(() => {
    window.__viewerState = {};
    window.acquireVsCodeApi = () => ({ getState: () => window.__viewerState, setState: next => { window.__viewerState = next; }, postMessage: m => window.hostMessage(m) });
    // Track lifecycle without timers in production or assumptions about a target FPS.
    const originalFrame = window.requestAnimationFrame.bind(window), originalCancel = window.cancelAnimationFrame.bind(window);
    const pending = new Set(), observers = new Map();
    window.requestAnimationFrame = callback => {
      const id = originalFrame(time => { pending.delete(id); callback(time); }); pending.add(id); return id;
    };
    window.cancelAnimationFrame = id => { pending.delete(id); originalCancel(id); };
    const OriginalObserver = window.ResizeObserver;
    window.ResizeObserver = class extends OriginalObserver {
      constructor(callback) { super(callback); observers.set(this, new Set()); }
      observe(target, options) { observers.get(this).add(target); return super.observe(target, options); }
      unobserve(target) { observers.get(this).delete(target); return super.unobserve(target); }
      disconnect() { observers.get(this).clear(); return super.disconnect(); }
    };
    window.__graphLifecycle = () => ({ frames: pending.size, orphanTargets: [...observers.values()].flatMap(items => [...items]).filter(item => !item.isConnected).length,
      observedTargets: [...observers.values()].reduce((sum, items) => sum + items.size, 0) });
    window.__measureGraphTransition = (key, trigger) => new Promise(resolve => {
      const started = performance.now(), samples = [];
      const sample = () => {
        const time = performance.now();
        const graph = document.querySelector('.graph-view'), item = [...(graph?.querySelectorAll('.graph-node') || [])].find(item => item.dataset.graphKey === key);
        samples.push({ ms: +(time - started).toFixed(2), transform: item?.getAttribute('transform') || null, nodes: graph?.querySelectorAll('.graph-node').length || 0,
          dom: graph?.querySelectorAll('*').length || 0, level: graph?.dataset.level || window.__viewerState.graph.level });
        if (time - started < 760) originalFrame(sample); else resolve({ elapsedMs: +(time - started).toFixed(2), samples });
      };
      sample();
      const target = [...document.querySelectorAll('.graph-node')].find(item => item.dataset.graphKey === trigger || item.dataset.graphKey === `visual:${trigger}`);
      if (!target) throw new Error(`Missing graph transition target: ${trigger}`);
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  });
  await page.goto(origin);

  await check('home explains S0 and template files without automatically reading a document', async () => {
    await page.locator('.identity-name').waitFor();
    assert.equal(await page.locator('.identity-name').textContent(), 'demo');
    assert.equal(messages.filter(m => m.type === 'read').length, 0);
    await page.getByText('Cómo está organizado este S0', { exact: true }).waitFor();
    await page.getByText(demoSnapshot.description, { exact: true }).waitFor();
    assert.equal(await page.locator('.stats .stat').count(), 4);
    assert.equal(await page.locator('.template-chips .flow-pill').count(), 6);
    assert.equal(await page.locator('.template-chips .flow-pill.is-absent').count(), 3);
    assert.equal(await page.locator('.hu-row').count(), 2);
    assert.equal(await page.locator('.statusbar, .titlebar, .psdt-cell, .workflow-box').count(), 0);
    await noHorizontalOverflow('Home 1280'); await screenshot('v2-01-home-dark');
  });
  await check('S0 selector preserves path entry and Escape closes its menu', async () => {
    await page.getByRole('button', { name: 'Cambiar S0', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Pegar ruta de S0…', exact: true }).click();
    assert.equal(messages.at(-1).type, 'enterRootPath');
    await page.getByRole('button', { name: 'Cambiar S0', exact: true }).click();
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('menu').isVisible(), false);
  });
  await check('HU shows five document steps and an inferred next step without inventing commands', async () => {
    // A fresh checkout changes mtimes and therefore the order of the home cards.
    await page.locator('[data-key="hu-row:catalog-search"]').click(); await page.locator('.hu-title').waitFor();
    assert.equal(await page.locator('.hu-title').textContent(), 'Búsqueda en el catálogo');
    assert.equal(await page.locator('.next-title').textContent(), 'Continuar tareas pendientes');
    assert.equal(await page.locator('.change-steps li').count(), 5);
    assert.equal(await page.getByRole('tab').count(), 5);
    assert.equal(await page.getByText('Cómo continuar, fuera del visor', { exact: true }).count(), 0);
    assert.equal(await page.getByText('Integración futura', { exact: true }).count(), 0);
    assert.equal(messages.filter(m => m.type === 'read').length, 0);
    await page.getByRole('button', { name: 'Abrir proposal.md', exact: true }).click();
    assert.deepEqual(lastOf('openSource'), { type: 'openSource', rootPath: snapshot.rootPath, path: 'openspec/changes/catalog-search/proposal.md' });
    await page.waitForFunction(() => document.querySelector('.view-root')?.getAttribute('aria-busy') === 'false');
    const flowHeading = await page.locator('.flow-heading .small-title').boundingBox();
    const flowNote = await page.locator('.flow-heading .flow-note').boundingBox();
    assert.ok(flowHeading && flowNote && Math.abs(flowHeading.y - flowNote.y) < 16, 'Wide HU keeps the document heading and its single caveat on the same row.');
    const stepProgress = await page.locator('.step-progress').boundingBox();
    assert.ok(stepProgress && stepProgress.height <= 24, 'The task count and progress remain compact in the document step.');
    assert.equal(await page.locator('.pagination[data-scope="documents"]').count(), 0, 'A fully read single document page does not show disabled pagination.');
    const basis = page.locator('details.next-basis');
    assert.equal(await basis.evaluate(item => item.open), false);
    await basis.locator('summary').focus(); await page.keyboard.press('Enter');
    assert.equal(await basis.evaluate(item => item.open), true);
    assert.match(await basis.locator('p').innerText(), /Basado en tasks\.md/);
    assert.match(await basis.locator('p').innerText(), /no es el estado oficial del workflow/);
    await basis.locator('summary').click();
    await screenshot('v2-02-hu-dark');
  });
  await check('HU tabs implement arrow navigation, roving focus and associated panels', async () => {
    await tab('Resumen').focus(); await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.querySelector('[role=tab][aria-selected=true]')?.textContent.startsWith('Propuesta'));
    assert.equal(await isActive(tab('Propuesta')), true);
    assert.equal(await page.locator('[role=tab][tabindex="0"]').count(), 1);
    const panelId = await tab('Propuesta').getAttribute('aria-controls');
    assert.ok(panelId && await page.locator(`[id="${panelId}"][role=tabpanel]`).count() === 1);
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(() => document.querySelector('[role=tab][aria-selected=true]')?.textContent === 'Resumen');
  });
  await check('task rows are read-only and filter all/pending/done while persisting UI state', async () => {
    await tab(/^Tareas/).click(); await page.locator('.task-filter').waitFor();
    assert.equal(await page.locator('[role=tabpanel] input').count(), 0);
    assert.equal(await page.locator('.task-row').count(), 5);
    await page.locator('.task-filter').getByRole('button', { name: /^Pendientes/ }).click();
    assert.equal(await page.locator('.task-row').count(), 3);
    assert.equal(await page.locator('.task-section').count(), 1);
    assert.equal(await page.evaluate(() => window.__viewerState.taskFilter), 'pending');
    await page.locator('.task-filter').getByRole('button', { name: /^Marcadas/ }).click();
    assert.equal(await page.locator('.task-row').count(), 2);
    await page.locator('.task-filter').getByRole('button', { name: /^Todas/ }).click();
    await screenshot('v2-03-tasks-dark');
  });
  await check('specs show structured requirements/scenarios and keep Markdown as an alternate view', async () => {
    await tab(/^Specs/).click(); await page.getByRole('button', { name: 'Leer delta', exact: true }).first().click();
    await waitDocument('openspec/changes/catalog-search/specs/catalog/spec.md');
    await page.locator('.spec-mode').waitFor();
    assert.equal(await page.locator('.spec-title').textContent(), 'Delta de catálogo');
    assert.equal(await page.locator('.spec-mode').getByRole('button', { name: 'Estructurada', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('.requirement-card').count(), 1);
    assert.equal(await page.locator('.scenario').count(), 3);
    assert.equal(await page.locator('.delta-cell').count(), 4);
    await page.getByText('obligatorio', { exact: true }).waitFor(); await page.locator('.pinned-hu').waitFor();
    await screenshot('v2-04-spec-structured');
    await page.locator('.spec-mode').getByRole('button', { name: 'Markdown', exact: true }).click();
    await page.locator('.markdown-body h3').first().waitFor();
    assert.equal(await page.evaluate(() => window.__viewerState.specMode), 'markdown');
    await page.locator('.spec-mode').getByRole('button', { name: 'Estructurada', exact: true }).click();
    await page.getByRole('button', { name: 'Volver a la HU', exact: true }).click();
  });
  await check('missing artifacts remain visible as missing', async () => {
    await page.locator('[data-key="nav:change:export-summary"]').click(); await page.locator('.hu-title').waitFor();
    assert.equal(await page.locator('.next-title').textContent(), 'Generar specs');
    assert.match(await tab(/^Diseño/).textContent(), /falta/);
    await tab(/^Diseño/).click(); await page.getByText('Diseño todavía no existe', { exact: true }).waitFor();
    await tab(/^Tareas/).click(); assert.equal(await page.locator('.task-row').count(), 0);
  });
  await check('context offers reading intentions and a real table linking components to HUs', async () => {
    await nav(/^Contexto del sistema/).click(); await page.getByText('¿Qué necesitas entender?', { exact: true }).waitFor();
    assert.equal(await page.locator('.intent').count(), 3);
    await page.getByText('Sin documento enlazado', { exact: true }).waitFor();
    assert.equal(await page.locator('.component-table table tbody tr').count(), 3);
    assert.ok(await page.locator('.component-table table button').count() > 0);
    assert.equal(await page.locator('.pagination[data-scope="context"]').count(), 0, 'A complete single context page keeps the component table next to its documents.');
    await screenshot('v2-05-context-dark');
    await page.locator('button.intent').first().click(); await page.locator('.diagram-visual svg').waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: 'Abrir Markdown', exact: true }).click();
    assert.deepEqual(lastOf('openSource'), { type: 'openSource', rootPath: snapshot.rootPath, path: 'docs/project.md' });
  });
  await check('diagram modal traps focus and returns focus on Escape', async () => {
    const zoom = page.locator('.diagram-zoom'); await zoom.click();
    const dialog = page.getByRole('dialog', { name: /Diagrama/ }); await dialog.waitFor();
    await page.locator('.dialog-canvas svg').waitFor(); await focusTrapped(dialog);
    await page.keyboard.press('Escape'); assert.equal(await dialog.count(), 0); assert.equal(await isActive(zoom), true);
  });
  await check('Ctrl+K searches content, filters scope, and opens a keyboard-selected result', async () => {
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Buscar en el S0', exact: true }); await dialog.waitFor();
    const input = dialog.locator('.search-input');
    // Opening a modal schedules focus on the next animation frame.
    await page.waitForFunction(() => document.querySelector('.search-dialog .search-input') === document.activeElement);
    assert.equal(await isActive(input), true);
    await input.fill('mayúsculas'); await page.locator('.search-result').first().waitFor();
    assert.equal(lastOf('search').query, 'mayúsculas'); assert.ok(await page.locator('.search-result mark').count() > 0);
    await focusTrapped(dialog); await input.focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('.search-dialog')); await page.locator('.doc-meta-path').waitFor();
    await page.keyboard.press('Control+k'); await dialog.locator('.search-input').fill('recursos');
    await dialog.locator('.search-scope').getByRole('button', { name: /^Specs/ }).click();
    await page.waitForFunction(() => document.querySelectorAll('.search-result').length > 0);
    assert.equal(lastOf('search').scope, 'specs'); await screenshot('v2-06-search');
    await page.keyboard.press('Escape'); assert.equal(await dialog.count(), 0);
    assert.equal(await page.evaluate(() => Object.hasOwn(window.__viewerState, 'searchQuery')), false);
  });
  await check('search snippets and Markdown cannot execute markup or fetch remote resources', async () => {
    searchOverride = [{ path: 'docs/project.md', kind: 'context', title: '<img src=x onerror=alert(1)>', count: 1, snippet: '<script>window.searchExecuted=true</script> malicious' }];
    await page.keyboard.press('Control+k'); await page.locator('.search-input').fill('malicious'); await page.locator('.search-result').waitFor();
    assert.equal(await page.locator('.search-result img, .search-result script').count(), 0); assert.equal(await page.evaluate(() => window.searchExecuted), undefined);
    await page.keyboard.press('Escape'); searchOverride = null;
    currentDocument = await readDocument(demo, 'docs/project.md');
    await nav(/^Contexto del sistema/).click(); await page.locator('button.intent').first().click(); await waitDocument('docs/project.md');
    await deliver({ type: 'document', document: { ...currentDocument, html: renderMarkdown('# Documento seguro\n<script>window.markdownExecuted=true</script>\n\n![tracker](https://example.invalid/tracker.png)\n\n[command](command:workbench.action.quit)') } });
    await page.getByText('Documento seguro', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.markdownExecuted), undefined); assert.equal(await page.locator('.markdown-body script, .markdown-body img').count(), 0);
  });
  await check('glossary explains status limits, traps focus, and restores its triggering control', async () => {
    const opener = page.locator('.explorer').getByRole('button', { name: 'Cómo leer este S0', exact: true }); await opener.click();
    const dialog = page.getByRole('dialog', { name: 'Cómo leer este S0', exact: true }); await dialog.waitFor();
    await dialog.getByText('Lo que este visor no afirma', { exact: true }).waitFor(); await focusTrapped(dialog); await screenshot('v2-07-glossary');
    await page.keyboard.press('Escape'); assert.equal(await dialog.count(), 0); assert.equal(await isActive(opener), true);
  });
  await check('archive displays folder-derived dates and specs display requirement/scenario counts', async () => {
    await nav(/^Archivo/).click(); assert.equal(await page.locator('.archive-row').count(), 1);
    assert.match(await page.locator('.archive-row').textContent(), /2026/); await page.getByText(/según el nombre de la carpeta/).waitFor();
    await nav(/^Specs/).click(); await page.getByText(/2 requisitos/).first().waitFor(); await page.getByText(/4 escenarios/).first().waitFor();
  });
  await check('read errors support retry/editor access and invalid diagrams keep readable source', async () => {
    // This proposal has not been read during earlier search/navigation checks.
    failingPath = 'openspec/changes/export-summary/proposal.md'; await page.locator('[data-key="nav:change:export-summary"]').click(); await tab(/^Propuesta/).click();
    await page.getByText('No se pudo leer proposal.md', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Abrir en el editor', exact: true }).click(); assert.deepEqual(lastOf('openSource'), { type: 'openSource', rootPath: snapshot.rootPath, path: failingPath });
    failingPath = null; await page.getByRole('button', { name: 'Reintentar', exact: true }).click(); await page.locator('.hu-doc .markdown-body').waitFor();
    await deliver({ type: 'document', document: { ...currentDocument, html: renderMarkdown('# Diagrama incorrecto\n\n```mermaid\nthis is not a diagram\n```') } });
    await page.locator('.diagram.is-error').waitFor(); await page.getByRole('button', { name: 'Copiar error', exact: true }).click(); assert.equal(lastOf('copyText').type, 'copyText');
  });
  await check('settings change reading size and editor surfaces without losing the HU', async () => {
    await openCatalog();
    for (const readingSize of [14, 16, 15]) {
      await deliver({ type: 'settings', readingSize, surfaces: 'personal' });
      // Capture values in one browser task: a lazy snapshot may replace the node
      // between locator resolution and evaluation, making its computed style empty.
      const rendered = await page.waitForFunction(size => {
        const purpose = document.querySelector('.hu-purpose');
        if (!purpose?.isConnected) return false;
        const actual = { fontSize: getComputedStyle(purpose).fontSize, readSize: window.__viewerState.readSize, selectedChange: window.__viewerState.selectedChange };
        return document.body.dataset.read === String(size) && actual.fontSize === `${size}px` && actual.readSize === size ? actual : false;
      }, readingSize);
      assert.deepEqual(await rendered.jsonValue(), { fontSize: `${readingSize}px`, readSize: readingSize, selectedChange: 'catalog-search' });
      await rendered.dispose();
    }
    await page.evaluate(() => { for (const [name, value] of Object.entries({ '--vscode-editor-background': '#202124', '--vscode-sideBar-background': '#18191b', '--vscode-foreground': '#e8eaed', '--vscode-descriptionForeground': '#bdc1c6', '--vscode-editorWidget-background': '#292a2d', '--vscode-panel-border': '#555555', '--vscode-list-inactiveSelectionBackground': '#3c4043' })) document.body.style.setProperty(name, value); });
    await deliver({ type: 'settings', readingSize: 16, surfaces: 'editor' }); await page.waitForFunction(() => document.body.classList.contains('os-surface-editor'));
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--os-paper').trim()), '#202124'); await screenshot('v2-08-editor-surfaces');
  });
  await check('light and high-contrast views work at 1280, 600 and 420 pixels', async () => {
    await deliver({ type: 'settings', readingSize: 15, surfaces: 'personal' });
    await page.evaluate(() => { document.body.classList.remove('vscode-dark'); document.body.classList.add('vscode-light'); document.body.removeAttribute('style'); });
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--os-divider').trim().toUpperCase()), '#D3E4FE');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.hu-tab.is-active')).color === 'rgb(11, 28, 48)');
    await screenshot('v2-09-hu-light');
    for (const width of [600, 420]) {
      await page.setViewportSize({ width, height: 900 }); await page.waitForFunction(() => document.querySelector('.is-tight'));
      assert.equal(await page.locator('.explorer').isVisible(), false); assert.equal(await page.locator('.rail').count(), 0);
      assert.equal(await page.locator('.next-title').isVisible(), true); await noHorizontalOverflow(`HU ${width}`); await screenshot(`v2-10-hu-${width}`);
    }
    await page.evaluate(() => { document.body.classList.remove('vscode-light'); document.body.classList.add('vscode-high-contrast'); for (const [name, value] of Object.entries({ '--vscode-editor-background': '#000000', '--vscode-sideBar-background': '#000000', '--vscode-foreground': '#ffffff', '--vscode-descriptionForeground': '#ffffff', '--vscode-contrastBorder': '#6fc3df', '--vscode-contrastActiveBorder': '#f38518', '--vscode-focusBorder': '#f38518', '--vscode-button-background': '#000000', '--vscode-button-foreground': '#ffffff', '--vscode-textLink-foreground': '#3794ff', '--vscode-input-background': '#000000', '--vscode-list-activeSelectionBackground': '#000000' })) document.body.style.setProperty(name, value); });
    await noHorizontalOverflow('HU 420 high contrast'); await screenshot('v2-11-high-contrast');
    await page.setViewportSize({ width: 1280, height: 900 }); await page.evaluate(() => { document.body.className = 'vscode-dark'; document.body.removeAttribute('style'); });
  });
  const pagingRoot = await mkdtemp(path.join(out, 'paging-'));
  await cp(demo, pagingRoot, { recursive: true });
  const put = async (relative, source) => { const file = path.join(pagingRoot, relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, source); };
  for (let n = 0; n < (process.env.SDD_VIEWER_UI_GRAPH_ONLY === 'demo' ? 0 : 105); n++) {
    const id = String(n).padStart(3, '0');
    await put(`docs/zz-context-${id}.md`, `# Contexto ${id}\n\ncontextual-exterior-${id}\n`);
    await put(`openspec/specs/zz-capability-${id}/spec.md`, `# Capacidad ${id}\n\n## Requirements\n\n### Requirement: Consultar ${id}\nEl usuario SHALL consultar ${id}.\n`);
    await put(`openspec/changes/catalog-search/notes/decision-${id}.md`, `# Decisión ${id}\n\nNota ficticia de paginación.\n`);
    if (n < 51) {
      await put(`openspec/changes/zz-active-${id}/proposal.md`, `# HU paginada ${id}\n\n## Why\nCambio ficticio.\n`);
      await put(`openspec/changes/archive/2025-01-01-zz-${id}/proposal.md`, `# Archivo ${id}\n\n${n === 50 ? 'resolucionhistoricaunica' : 'Historia ficticia.'}\n`);
    }
  }
  await put('openspec/changes/catalog-search/revision.md', '# Registro paginado\n\nDecisiones ficticias conservadas entre páginas.\n\n## DEC-001 — Fuente de contexto\n\n- Estado: registrada\n- Artefacto: [diseño](design.md)\n\n## DEC-002 — Alternativa anterior\n\n- Estado: sustituida\n');
  currentRoot = pagingRoot; currentDocument = null; scanOptions = { pages: {}, selectedChange: null, changePage: 0 };
  snapshot = await scanRoot(currentRoot, scanOptions);
  await deliver({ type: 'snapshot', snapshot, document: null });
  await check('each catalog pages independently with keyboard controls and honest page counts', async () => {
    for (const scope of ['changes', 'specs', 'context', 'archive']) {
      if (scope === 'changes') { await nav(/^Inicio del S0/).click(); await page.locator('[data-key="stat:changes"]').click(); }
      else await nav(scope === 'specs' ? /^Specs/ : scope === 'context' ? /^Contexto del sistema/ : /^Archivo/).click();
      const pager = page.locator(`.pagination[data-scope="${scope}"]`);
      await pager.getByText(/Página 1 ·/).waitFor();
      assert.equal(await pager.getByRole('button', { name: 'Página anterior', exact: true }).isDisabled(), true);
      const next = pager.getByRole('button', { name: 'Página siguiente', exact: true });
      assert.equal(await next.isDisabled(), false); await next.focus(); await page.keyboard.press('Enter');
      await pager.getByText(/Página 2 ·/).waitFor(); assert.equal(lastOf('page').scope, scope); assert.equal(lastOf('page').page, 1);
      assert.equal(lastOf('page').rootPath, snapshot.rootPath);
      await pager.getByRole('button', { name: 'Página anterior', exact: true }).click(); await pager.getByText(/Página 1 ·/).waitFor();
    }
    await page.setViewportSize({ width: 420, height: 900 }); await noHorizontalOverflow('Archivo paginado 420');
    await screenshot('v3-01-paged-archive-420'); await page.setViewportSize({ width: 1280, height: 900 });
  });
  await check('a failed catalog request keeps its data and retries the requested page', async () => {
    await nav(/^Contexto del sistema/).click(); const pager = page.locator('.pagination[data-scope="context"]');
    const first = await page.locator('.doc-row-path').first().textContent();
    failingScope = 'context'; await pager.getByRole('button', { name: 'Página siguiente', exact: true }).click();
    await pager.getByText('Fallo de página simulado.', { exact: true }).waitFor();
    assert.equal(await page.locator('.doc-row-path').first().textContent(), first);
    failingScope = null; await pager.getByRole('button', { name: 'Reintentar página', exact: true }).click();
    await pager.getByText(/Página 2 ·/).waitFor(); assert.equal(lastOf('page').page, 1);
    await put('docs/zz-context-000.md', '# Contexto grande\n' + 'x'.repeat(1024 * 1024));
    await pager.getByRole('button', { name: 'Página anterior', exact: true }).click(); await pager.getByText(/Página 1 ·/).waitFor();
    await pager.getByText(/Lectura parcial:/).waitFor();
    await pager.getByRole('button', { name: 'Reintentar página', exact: true }).click(); await pager.getByText(/Página 1 ·/).waitFor();
    assert.equal(lastOf('page').page, 0, 'A later partial page must not reuse the old failed page number.');
    await put('docs/zz-context-000.md', '# Contexto 000\n\ncontextual-exterior-000\n');
    await pager.getByRole('button', { name: 'Reintentar página', exact: true }).click(); await pager.getByText(/Página 1 ·/).waitFor();
    assert.equal(await pager.locator('.pagination-note').count(), 0);
  });
  await check('archive opens lazily and distinguishes unknown, loading, failure and verified absence', async () => {
    await nav(/^Archivo/).click();
    assert.match(await page.locator('.archive-row-tasks').first().textContent(), /sin cargar/);
    holdChange = true; await page.locator('.archive-row').first().click(); await page.getByText('Leyendo documentos de la HU…', { exact: true }).waitFor();
    assert.equal(await page.locator('.change-step.is-unknown').count(), 4);
    assert.equal(await page.locator('.change-step.is-absent').count(), 0);
    const id = lastOf('loadChange').id;
    await deliver({ type: 'loadError', id, message: 'Fallo de HU simulado.' }); await page.getByText('No se pudo cargar la HU', { exact: true }).waitFor();
    holdChange = false; await page.getByRole('button', { name: 'Reintentar HU', exact: true }).click(); await page.locator('.hu-tabs').waitFor();
    await tab(/^Tareas/).click(); await page.getByRole('heading', { name: 'Tareas · falta', exact: true }).waitFor();
    assert.equal(lastOf('loadChange').id, id);
  });
  await check('HU document pages keep the base artifacts and the selected revision tab', async () => {
    await openCatalog(); const pager = page.locator('.pagination[data-scope="documents"]');
    await pager.getByText(/Página 1 ·/).waitFor();
    await tab('Revisión registrada').click(); await waitDocument('openspec/changes/catalog-search/revision.md');
    await pager.getByRole('button', { name: 'Página siguiente', exact: true }).click(); await pager.getByText(/Página 2 ·/).waitFor();
    await waitDocument('openspec/changes/catalog-search/revision.md');
    assert.equal(await tab('Revisión registrada').getAttribute('aria-selected'), 'true');
    assert.equal(await tab(/^Propuesta/).count(), 1); assert.equal(await tab(/^Diseño/).count(), 1); assert.equal(await tab(/^Tareas/).count(), 1);
    assert.equal(lastOf('loadChange').page, 1);
  });
  await check('rapid HU navigation can reopen a selection whose previous request was superseded', async () => {
    await page.locator('[data-key="nav:change:export-summary"]').click(); await page.locator('.hu-tabs').waitFor();
    await page.waitForFunction(() => document.querySelector('.main [aria-busy="true"]') === null);
    const before = messages.filter(message => message.type === 'loadChange' && message.id === 'catalog-search').length;
    holdChange = true;
    await page.locator('[data-key="nav:change:catalog-search"]').click();
    await page.locator('[data-key="nav:change:export-summary"]').click();
    holdChange = false;
    await page.locator('[data-key="nav:change:catalog-search"]').click();
    await page.locator('.pagination[data-scope="documents"]').getByText(/Página 1 ·/).waitFor();
    await page.waitForFunction(() => document.querySelector('.main [aria-busy="true"]') === null);
    assert.equal(messages.filter(message => message.type === 'loadChange' && message.id === 'catalog-search').length, before + 2);
  });
  await check('search opens documents beyond the visible page and searches archives only on request', async () => {
    assert.equal(snapshot.docs.some(item => item.path === 'docs/zz-context-104.md'), false);
    await page.keyboard.press('Control+k'); const dialog = page.getByRole('dialog', { name: 'Buscar en el S0', exact: true });
    await dialog.locator('.search-scope').getByRole('button', { name: 'Contexto', exact: true }).click();
    await dialog.locator('.search-input').fill('contextual-exterior-104'); await page.locator('.search-result').first().waitFor();
    await dialog.locator('.search-input').press('Enter'); await waitDocument('docs/zz-context-104.md');
    await page.keyboard.press('Control+k'); await dialog.locator('.search-scope').getByRole('button', { name: 'Todo vigente', exact: true }).click();
    await dialog.locator('.search-input').fill('resolucionhistoricaunica'); await page.getByText('Sin coincidencias. Prueba otra palabra.', { exact: true }).waitFor();
    await dialog.locator('.search-scope').getByRole('button', { name: 'Archivo', exact: true }).click(); await page.locator('.search-result').first().waitFor();
    assert.equal(lastOf('search').scope, 'archive');
    await dialog.locator('.search-input').press('Enter'); await waitDocument('openspec/changes/archive/2025-01-01-zz-050/proposal.md');
    await page.getByRole('button', { name: 'Volver a la HU', exact: true }).click(); await page.locator('.hu-tabs').waitFor();
    assert.equal(lastOf('loadChange').id, 'archive/2025-01-01-zz-050');
  });
  await check('knowledge graph indexes outside catalogue pages and keeps archive and inferences opt-in', async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await nav('Grafo del S0').click(); await page.locator('.graph-canvas').waitFor();
    assert.equal(currentGraph.coverage.archive.status, 'excluded');
    assert.equal(lastOf('graph').includeInferred, false);
    assert.ok(currentGraph.nodes.some(item => item.path === 'docs/zz-context-104.md'));
    assert.ok(currentGraph.nodes.some(item => item.kind === 'decision' && item.decisionId === 'DEC-001'));
    assert.ok(currentGraph.nodes.some(item => item.kind === 'decision' && item.state === 'superseded'));
    await openGraphList();
    await page.locator('.graph-equivalent-list').getByRole('button', { name: /^Contexto ·/ }).click();
    await page.getByRole('button', { name: 'Página siguiente', exact: true }).click();
    await page.getByRole('button', { name: 'Página siguiente', exact: true }).click();
    const outside = currentGraph.nodes.find(item => item.kind === 'document' && item.path === 'docs/zz-context-104.md');
    await openGraphList();
    await page.locator('.graph-equivalent-list').getByRole('button', { name: outside.label + ' Documento', exact: true }).click();
    await page.locator('.graph-details').getByRole('button', { name: 'Abrir en el lector', exact: true }).click();
    await waitDocument('docs/zz-context-104.md');
    await nav('Grafo del S0').click();
    await page.getByRole('button', { name: 'Incluir archivo', exact: true }).click();
    await page.locator('.graph-canvas').waitFor();
    assert.notEqual(currentGraph.coverage.archive.status, 'excluded');
    const graphReads = messages.filter(item => item.type === 'graph').length;
    await page.getByRole('button', { name: 'Inferidas', exact: true }).click();
    await page.locator('.graph-canvas').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Inferidas', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(messages.filter(item => item.type === 'graph').length, graphReads);
  });
  currentRoot = demo; currentDocument = null; scanOptions = { pages: {}, selectedChange: null, changePage: 0 };
  snapshot = structuredClone(demoSnapshot); await deliver({ type: 'snapshot', snapshot, document: null });
  await check('graph measurements use the same demo and record actual layout samples without FPS claims', async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const started = performance.now();
    await nav('Grafo del S0').click(); await page.locator('.graph-canvas').waitFor();
    const mapReadyMs = +(performance.now() - started).toFixed(2);
    await page.getByRole('button', { name: 'Mapa del S0', exact: true }).click();
    await page.waitForTimeout(650);
    const change = currentGraph.nodes.find(item => item.kind === 'change' && item.scope !== 'archive');
    assert.ok(change, 'The common demo contains an active HDU.');
    const map = await page.locator('.graph-view').evaluate(item => ({ dom: item.querySelectorAll('*').length, nodes: item.querySelectorAll('.graph-node').length,
      canvas: { width: item.querySelector('.graph-canvas').getBoundingClientRect().width, height: item.querySelector('.graph-canvas').getBoundingClientRect().height } }));
    const transition = await page.evaluate(({ id }) => window.__measureGraphTransition(id, 'zone:changes'), { id: change.id });
    const measurement = { edition: graphBaseline ? 'before-0.3.1' : 'after', corpus: 'bundled demo, archive and inferred mentions excluded', viewport: { width: 1280, height: 900 },
      browser: report.browser, map, mapReadyMs, totalObservationMs: +(performance.now() - started).toFixed(2), transition,
      distinctVisiblePositions: new Set(transition.samples.map(item => item.transform).filter(Boolean)).size };
    await mkdir(graphEvidence, { recursive: true });
    await writeFile(path.join(graphEvidence, `${graphBaseline ? 'before' : 'after'}-measurements.json`), JSON.stringify(measurement, null, 2));
    report.graphMeasurement = measurement;
    await screenshot(graphBaseline ? 'before-graph-zone-measured' : 'after-graph-zone-measured');
    await page.emulateMedia({ reducedMotion: 'reduce' });
  });
  await check('graph map, zone, neighbourhood and source evidence work with keyboard at 600, 1040 and 1280', async () => {
    await nav('Grafo del S0').click(); await page.locator('.graph-canvas').waitFor();
    for (const width of [1280, 1040, 600]) {
      await page.setViewportSize({ width, height: 900 });
      await page.getByRole('button', { name: 'Mapa del S0', exact: true }).click();
      await noHorizontalOverflow(`Graph map ${width}`); await screenshot(`v3-graph-map-${width}`);
      await openGraphList();
      await page.locator('.graph-equivalent-list').getByRole('button', { name: /^HU en curso ·/ }).focus();
      await page.keyboard.press('Enter');
      await openGraphList();
      const entry = page.locator('.graph-equivalent-list button').first(); await entry.focus(); await page.keyboard.press('Enter');
      await page.locator('.graph-details').waitFor();
      await closeGraphList();
      await page.getByRole('button', { name: 'Ver vecindario', exact: true }).click();
      assert.ok(await page.locator('.graph-relations li').count() > 0);
      await page.locator('.graph-evidence').first().click();
      assert.equal(lastOf('openSource').line, 1);
      assert.ok(lastOf('openSource').path.endsWith('.md'));
      await noHorizontalOverflow(`Graph neighbourhood ${width}`); await screenshot(`v3-graph-neighbourhood-${width}`);
      await page.getByRole('button', { name: 'Cerrar ficha', exact: true }).focus(); await page.keyboard.press('Escape');
      assert.equal(await page.locator('.graph-details').count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Incluir archivo', exact: true }).isVisible(), true);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => { document.body.className = 'vscode-high-contrast'; });
    await screenshot('v3-graph-high-contrast');
    await page.evaluate(() => { document.body.className = 'vscode-dark'; });
    await page.getByRole('button', { name: 'Mapa del S0', exact: true }).click();
    await openGraphList();
    await page.locator('.graph-equivalent-list').getByRole('button', { name: /^Capacidades y specs ·/ }).click();
    const requirement = currentGraph.nodes.find(item => item.kind === 'requirement' && item.scope === 'specs');
    const owner = currentGraph.nodes.find(item => item.id === requirement.owner);
    await openGraphList();
    await page.locator('.graph-equivalent-list button').filter({ hasText: owner.label }).first().click();
    await page.getByRole('button', { name: 'Ver vecindario', exact: true }).click();
    await openGraphList();
    await page.locator('.graph-equivalent-list button').filter({ hasText: requirement.label }).first().click();
    await page.locator('.graph-details').getByRole('button', { name: 'Abrir en el lector', exact: true }).click();
    await waitDocument(requirement.path);
    await page.waitForFunction(anchor => document.activeElement?.id === anchor, requirement.anchor);
  });
  await check('graph fidelity shows entries, a floating dock, related-node hover and preserves the camera during selection', async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await nav('Grafo del S0').click(); await page.locator('.graph-canvas').waitFor();
    await page.getByRole('button', { name: 'Mapa del S0', exact: true }).click();
    assert.ok(await page.locator('.graph-canvas .graph-node').count() > 8, 'Map includes actual documents, beyond seven zones and S0.');
    assert.ok(await page.locator('.graph-canvas .graph-kind-document').count() > 0);
    assert.equal(await page.locator('details.graph-list-panel').evaluate(item => item.open), false, 'The accessible list does not occupy the map by default.');
    const canvas = await page.locator('.graph-canvas').boundingBox(), dock = await page.locator('.graph-toolbar').boundingBox();
    assert.ok(dock.y > canvas.y + canvas.height / 2, 'Filters and camera controls are docked at the bottom of the canvas.');
    const change = currentGraph.nodes.find(item => item.kind === 'change' && item.scope !== 'archive');
    const point = await graphPoint(change.id); await page.mouse.move(point.x, point.y);
    await page.locator('.graph-tooltip').waitFor({ state: 'visible' });
    assert.match(await page.locator('.graph-tooltip').innerText(), /relaci|HDU|HU/i);
    assert.ok(await page.locator('.graph-node').evaluateAll(items => items.some(item => Number(getComputedStyle(item).opacity) < .5)), 'Hover dims unrelated entries.');
    await page.mouse.move(canvas.x + canvas.width - 25, canvas.y + 150);
    await page.mouse.wheel(0, -200);
    const zoomed = await graphCamera(); assert.ok(Number(zoomed.zoom) > 1);
    await page.mouse.down(); await page.mouse.move(canvas.x + canvas.width - 70, canvas.y + 180, { steps: 4 }); await page.mouse.up();
    const camera = await graphCamera();
    assert.ok(Number(camera.panX) !== 0 || Number(camera.panY) !== 0, 'Dragging the background pans the camera.');
    await clickGraphNode(change.id); await page.locator('.graph-details').waitFor();
    assert.deepEqual(await graphCamera(), camera, 'Selecting an entry keeps zoom and pan.');
    await page.getByRole('button', { name: 'Cerrar ficha', exact: true }).click();
    await toggleGraphArchive(true);
    assert.deepEqual(await graphCamera(), camera, 'Including the archive keeps the camera after replacing the index.');
    await toggleGraphArchive(false);
    assert.deepEqual(await graphCamera(), camera, 'Excluding the archive also preserves zoom and pan.');
    await page.getByRole('button', { name: 'Encuadrar', exact: true }).click();
    assert.equal(Number((await graphCamera()).zoom), 1);
    await screenshot('v4-fidelity-map-1280');
  });
  await check('graph fidelity navigates SVG nodes by click and double click with an overlay sheet at 600 pixels', async () => {
    const change = currentGraph.nodes.find(item => item.kind === 'change' && item.scope !== 'archive');
    for (const reducedMotion of ['no-preference', 'reduce']) {
      await page.emulateMedia({ reducedMotion });
      for (const delay of [180, 240]) {
        await page.getByRole('button', { name: 'Mapa del S0', exact: true }).click();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        if (reducedMotion === 'no-preference') await page.waitForTimeout(650);
        assert.equal(await page.locator('.graph-details').count(), 0);
        await clickGraphNode(change.id, true, delay);
        await page.waitForFunction(id => document.querySelector('.graph-view')?.dataset.level === 'local'
          && window.__viewerState.graph.focus === id, change.id);
        assert.equal(await page.locator('.graph-details').count(), 1, `Delayed double click (${delay}ms, ${reducedMotion}) still opens the clicked entry's neighborhood when the first click resizes the canvas.`);
      }
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('button', { name: 'Mapa del S0', exact: true }).click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await clickGraphNode('zone:changes', true);
    await page.waitForFunction(() => document.querySelector('.graph-view')?.dataset.level === 'zone');
    await clickGraphNode('zone:changes', true);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('.graph-view')?.dataset.level === 'map');
    assert.equal(await page.locator('.graph-details').count(), 0, 'Double-clicking a zone creates only one back-history entry.');
    await clickGraphNode('zone:changes');
    await page.waitForFunction(() => document.querySelector('.graph-view')?.dataset.level === 'zone');
    await page.getByRole('button', { name: 'Zona siguiente', exact: true }).click();
    assert.equal(await page.evaluate(() => window.__viewerState.graph.zone), 'specs');
    await toggleGraphArchive(true);
    assert.equal(await page.locator('.graph-view').getAttribute('data-level'), 'zone');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('.graph-view')?.dataset.level === 'zone'
      && window.__viewerState.graph.zone === 'changes');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('.graph-view')?.dataset.level === 'map');
    await toggleGraphArchive(false);
    await clickGraphNode('zone:changes');
    await page.waitForFunction(() => document.querySelector('.graph-view')?.dataset.level === 'zone');
    await clickGraphNode(change.id); await page.locator('.graph-details').waitFor();
    await clickGraphNode(change.id, true);
    await page.waitForFunction(() => document.querySelector('.graph-view')?.dataset.level === 'local');
    assert.ok(await page.locator('.graph-node.graph-kind-task, .graph-node.graph-kind-requirement').count() > 0, 'HDU neighbourhood includes detail under its documents.');
    await screenshot('v4-fidelity-neighbourhood-1280');
    await page.keyboard.press('Escape'); assert.equal(await page.locator('.graph-details').count(), 0);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('.graph-view')?.dataset.level === 'zone');
    await page.setViewportSize({ width: 600, height: 900 });
    await clickGraphNode(change.id); await page.locator('.graph-details').waitFor();
    const sheet = await page.locator('.graph-details').evaluate(item => { const rect = item.getBoundingClientRect(); return { width: rect.width, x: rect.x, right: rect.right, position: getComputedStyle(item).position }; });
    assert.ok(Math.abs(sheet.width - 320) <= 1, `Expected 320px sheet, got ${sheet.width}.`);
    assert.ok(['absolute', 'fixed'].includes(sheet.position), 'Narrow sheet overlays the graph instead of moving below it.');
    assert.ok(sheet.x >= 0 && sheet.right <= 601); await noHorizontalOverflow('Graph overlay 600');
    await screenshot('v4-fidelity-sheet-600');
    await page.getByRole('button', { name: 'Cerrar ficha', exact: true }).focus(); await page.keyboard.press('Escape');
    assert.equal(await page.locator('.graph-details').count(), 0);
    await page.setViewportSize({ width: 1280, height: 900 });
  });
  await check('graph motion interpolates positions, honors reduced motion and releases frames and resize observers on exit', async () => {
    const change = currentGraph.nodes.find(item => item.kind === 'change' && item.scope !== 'archive');
    await page.getByRole('button', { name: 'Mapa del S0', exact: true }).click();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const normal = await page.evaluate(({ id }) => window.__measureGraphTransition(id, 'zone:changes'), { id: change.id });
    const normalPositions = normal.samples.map(item => item.transform).filter(Boolean);
    assert.ok(new Set(normalPositions).size > 2, 'The same HDU moves through intermediate positions instead of jumping between layouts.');
    const finalPosition = normalPositions.at(-1);
    assert.notEqual(normalPositions[0], finalPosition);
    assert.ok(normal.samples.some(item => item.ms > 60 && item.ms < 500 && item.transform !== normalPositions[0] && item.transform !== finalPosition), 'An intermediate position is visible during the intended 520ms transition.');
    assert.ok(normal.samples.filter(item => item.ms > 650).every(item => item.transform === finalPosition), 'Positions settle after the transition.');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('button', { name: 'Mapa del S0', exact: true }).click();
    const reduced = await page.evaluate(({ id }) => window.__measureGraphTransition(id, 'zone:changes'), { id: change.id });
    const reducedPositions = new Set(reduced.samples.slice(1).map(item => item.transform).filter(Boolean));
    assert.equal(reducedPositions.size, 1, 'Reduced motion reaches the final layout directly.');
    const live = await page.evaluate(() => window.__graphLifecycle()); assert.equal(live.frames, 0, 'A settled graph has no permanent animation loop.');
    await nav(/^Inicio del S0/).click(); await page.waitForTimeout(100);
    const outside = await page.evaluate(() => window.__graphLifecycle());
    assert.equal(outside.frames, 0); assert.equal(outside.orphanTargets, 0, 'Leaving the graph disconnects its ResizeObserver.');
    for (let iteration = 0; iteration < 3; iteration++) {
      await nav('Grafo del S0').click(); await page.locator('.graph-canvas').waitFor();
      await nav(/^Inicio del S0/).click(); await page.waitForTimeout(50);
    }
    assert.deepEqual(await page.evaluate(() => window.__graphLifecycle()), outside, 'Repeated navigation does not retain graph observers or frames.');
    await writeFile(path.join(graphEvidence, 'motion-samples.json'), JSON.stringify({ normal, reduced, outside }, null, 2));
  });
  await check('graph details paginate every relation and source without dropping evidence', async () => {
    await nav('Grafo del S0').click();
    const central = { id: 'doc:docs/INDICE.md', kind: 'document', path: 'docs/INDICE.md', label: 'Documento central', scope: 'context' };
    const others = Array.from({ length: 205 }, (_, i) => ({ ...central, id: `fixture:${i}`, label: `Vecino ${i}` }));
    const graph = { schemaVersion: 1, rootPath: snapshot.rootPath, nodes: [central, ...others], edges: others.map((item, i) => ({
      id: `fixture-edge:${i}`, from: item.id, to: central.id, type: 'references', origin: 'explicit', inferred: false, resolution: 'resolved',
      evidence: Array.from({ length: i === 0 ? 45 : 1 }, (_, n) => ({ path: 'docs/INDICE.md', line: n + 1 })),
    })), coverage: { context: { status: 'complete', read: 206 }, archive: { status: 'excluded', read: 0 } }, diagnostics: [] };
    await deliver({ type: 'graph', rootPath: snapshot.rootPath, requestId: lastOf('graph').requestId, index: graph });
    await page.getByRole('button', { name: 'Mapa del S0', exact: true }).click();
    await openGraphList();
    await page.locator('.graph-equivalent-list').getByRole('button', { name: /^Contexto ·/ }).click();
    await openGraphList();
    await page.locator('.graph-equivalent-list button').filter({ hasText: 'Documento central' }).click();
    assert.equal(await page.locator('.graph-relations > li').count(), 100);
    assert.equal(await page.locator('.graph-relations > li').first().locator('.graph-evidence').count(), 20);
    await page.getByRole('button', { name: 'Más evidencias', exact: true }).click();
    await page.getByText('Evidencias 21–40 de 45', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Más evidencias', exact: true }).click();
    await page.getByText('Evidencias 41–45 de 45', { exact: true }).waitFor();
    assert.equal(await page.locator('.graph-relations > li').first().locator('.graph-evidence').count(), 5);
    await page.getByRole('button', { name: 'Más relaciones', exact: true }).click();
    await page.getByText('Relaciones 101–200 de 205', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Más relaciones', exact: true }).click();
    assert.equal(await page.locator('.graph-relations > li').count(), 5);
    await page.getByRole('button', { name: 'Cerrar ficha', exact: true }).focus(); await page.keyboard.press('Enter');
    assert.equal(await page.getByRole('button', { name: 'Mapa del S0', exact: true }).evaluate(item => item === document.activeElement), true);
    const resource = { id: 'resource:package.json', kind: 'resource', path: 'package.json', label: 'package.json', scope: 'resources' };
    await deliver({ type: 'graph', rootPath: snapshot.rootPath, requestId: lastOf('graph').requestId,
      index: { ...graph, nodes: [central, resource], edges: [{ ...graph.edges[0], from: central.id, to: resource.id }] } });
    await graphNode(central.id).focus(); await page.keyboard.press('Shift+Enter');
    await page.waitForFunction(() => document.querySelector('.graph-view')?.dataset.level === 'local');
    const resourceNode = graphNode(resource.id);
    assert.equal(await resourceNode.getAttribute('aria-label'), 'package.json Recurso');
    await resourceNode.focus(); await page.locator('.graph-tooltip').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.graph-tooltip strong').textContent(), 'Recurso · package.json');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.graph-detail-heading .overline').textContent(), 'Recurso');
  });
  await check('empty S0, invalid folder and no-folder states remain actionable', async () => {
    snapshot = { ...structuredClone(demoSnapshot), rootName: 'S0 vacío', rootPath: 'empty-fixture', changes: [], pagination: undefined, demo: false };
    await deliver({ type: 'snapshot', snapshot, document: null }); await page.getByText('Este S0 está listo para su primera HU', { exact: true }).waitFor(); await screenshot('v2-12-no-hu');
    await deliver({ type: 'invalidRoot', path: 'C:\\projects\\catalog-app', codeRepository: true, message: 'La carpeta debe contener openspec/config.yaml, openspec/changes o openspec/specs.' });
    await page.getByText('Esta carpeta no contiene OpenSpec', { exact: true }).waitFor(); await page.getByRole('button', { name: 'Elegir otra carpeta', exact: true }).click(); assert.equal(messages.at(-1).type, 'chooseRoot');
    await page.getByRole('button', { name: 'Volver a S0 vacío', exact: true }).click();
    snapshot = { rootName: 'Visor local', rootPath: '', readAt: null, changes: [], specs: [], docs: [], repositories: [], intents: null, warnings: [] };
    await deliver({ type: 'snapshot', snapshot, document: null }); await page.getByText('Elige un S0 para empezar', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Abrir demo', exact: true }).click(); assert.equal(messages.filter(m => m.type === 'demo').length, 1);
  });
  await check('browser reports no JavaScript errors or external resource requests', async () => { assert.deepEqual(errors, []); assert.deepEqual(requests.filter(url => !url.startsWith(origin)), []); });
  report.passed = true; console.log(`UI: ${report.checks.length} checks passed. Screenshots: ${out}`);
} catch (error) {
  report.error = error.stack || String(error); report.browserErrors = errors; console.error('Browser errors:', errors); await page?.screenshot({ path: path.join(out, 'v2-failure.png') }).catch(() => {}); throw error;
} finally {
  await writeFile(path.join(out, process.env.SDD_VIEWER_UI_GRAPH_ONLY ? 'graph-report.json' : 'v2-report.json'), JSON.stringify(report, null, 2)); await browser?.close(); await new Promise(resolve => server.close(resolve));
}
