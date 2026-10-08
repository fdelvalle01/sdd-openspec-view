import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { archiveDate, contextDescription, contractReferences, countTasks, locateDocument, nextStep, parseIntents, proposalSummary, readDocument, relatedComponents, resolveLink, scanRoot, searchDocuments, searchWarnings } from '../src/model.js';

async function fixture(t, files = {}) {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'openspec-viewer-test-'));
  const root = path.join(fixtureRoot, 'workspace');
  await mkdir(root);
  t.after(async () => {
    const resolved = path.resolve(fixtureRoot);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('openspec-viewer-test-'));
    await rm(resolved, { recursive: true, force: true });
  });
  async function put(relative, content) {
    const target = path.resolve(root, relative);
    const local = path.relative(root, target);
    assert.ok(local && !local.startsWith('..') && !path.isAbsolute(local));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  for (const [relative, content] of Object.entries(files)) await put(relative, content);
  return { fixtureRoot, root, put };
}

const normalized = value => value.replaceAll('\\', '/');
const documentPaths = documents => documents.map(document => normalized(document.path)).sort();

async function treeDigest(root) {
  const entries = [];
  async function visit(directory, relative = '') {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const local = path.join(relative, child.name);
      if (child.isDirectory()) {
        entries.push(`directory:${normalized(local)}`);
        await visit(path.join(directory, child.name), local);
      } else if (child.isFile()) {
        const digest = createHash('sha256').update(await readFile(path.join(directory, child.name))).digest('hex');
        entries.push(`file:${normalized(local)}:${digest}`);
      }
    }
  }
  await visit(root);
  return entries;
}

test('scan separates active changes, archives, canonical specs, and project context', async t => {
  const { root } = await fixture(t, {
    'openspec/config.yaml': 'schema: spec-driven\n',
    'openspec/changes/add-search/proposal.md': '# Search\n',
    'openspec/changes/add-search/design.md': '# Search design\n',
    'openspec/changes/add-search/tasks.md': '- [x] Index data\n- [ ] Search UI\n',
    'openspec/changes/add-search/specs/search/spec.md': '# Search requirements\n',
    'openspec/changes/archive/2026-01-02-old-search/proposal.md': '# Previous search\n',
    'openspec/changes/archive/2026-01-02-old-search/tasks.md': '- [x] Ship\n',
    'openspec/specs/catalog/nested/spec.md': '# Catalog requirements\n',
    'README.md': '# Project\n',
    'AGENTS.md': '# Contributor instructions\n',
    'docs/setup.md': '# Setup\n',
    'docs/guides/development.md': '# Development\n',
    'docs/node_modules/ignored.md': '# Dependency\n',
    'docs/.git/ignored.md': '# Git internals\n',
    'private/ignored.md': '# Unrelated content\n',
    'repositorios.json': JSON.stringify({ schemaVersion: 1, system: 'demo', repositories: [{ id: 'api', role: 'backend', url: 'https://example.test/api.git', requiredFor: [] }] }),
  });
  const result = await scanRoot(root);
  assert.equal(result.changes.length, 2);
  const active = result.changes.find(change => change.id === 'add-search');
  const archived = result.changes.find(change => change.id === 'archive/2026-01-02-old-search');
  assert.ok(active);
  assert.equal(active.archived, false);
  assert.equal(archived?.archived, true);
  assert.deepEqual(active.tasks, { total: 2, done: 1 });
  assert.ok(documentPaths(active.documents).includes('openspec/changes/add-search/specs/search/spec.md'));
  assert.ok(active.artifacts.some(artifact => artifact.present));
  assert.ok(active.updatedAt);
  assert.deepEqual(documentPaths(result.specs), ['openspec/specs/catalog/nested/spec.md']);
  assert.deepEqual(documentPaths(result.docs), ['AGENTS.md', 'README.md', 'docs/guides/development.md', 'docs/setup.md']);
  assert.deepEqual(result.repositories.map(({ id, role, url }) => ({ id, role, url })), [{ id: 'api', role: 'backend', url: 'https://example.test/api.git' }]);
  assert.ok(result.rootName);
  assert.equal(await realpath(result.rootPath), await realpath(root));
  assert.ok(result.readAt);
});

test('task counts ignore fenced examples, quoted examples, and text outside lists', () => {
  const source = [
    '# Tasks',
    '- [x] Complete',
    '- [ ] Pending',
    '  - [X] Nested complete',
    '* [ ] Another pending',
    '[x] This is prose',
    '> - [x] Quoted example',
    '```markdown',
    '- [x] Code example',
    '```',
    '~~~markdown',
    '- [ ] Another code example',
    '~~~',
    'Inline `- [x] example`.',
  ].join('\n');
  assert.deepEqual(countTasks(source), { total: 4, done: 2 });
  assert.deepEqual(countTasks('No tasks here.'), { total: 0, done: 0 });
});

test('a rescan reflects saved tasks, new changes, and deleted documents', async t => {
  const { root, put } = await fixture(t, {
    'openspec/config.yaml': 'schema: spec-driven\n',
    'openspec/changes/first/proposal.md': '# First\n',
    'openspec/changes/first/tasks.md': '- [ ] Work\n',
  });
  const before = await scanRoot(root);
  assert.deepEqual(before.changes[0].tasks, { total: 1, done: 0 });
  await put('openspec/changes/first/tasks.md', '- [x] Work\n- [ ] Follow up\n');
  await put('openspec/changes/second/proposal.md', '# Second\n');
  const removed = path.resolve(root, 'openspec/changes/first/proposal.md');
  assert.ok(!path.relative(root, removed).startsWith('..'));
  await rm(removed);
  const after = await scanRoot(root);
  assert.deepEqual(after.changes.map(change => change.id).sort(), ['first', 'second']);
  const first = after.changes.find(change => change.id === 'first');
  assert.deepEqual(first.tasks, { total: 2, done: 1 });
  assert.ok(!documentPaths(first.documents).includes('openspec/changes/first/proposal.md'));
  const removedChange = path.resolve(root, 'openspec/changes/second');
  assert.ok(!path.relative(root, removedChange).startsWith('..'));
  await rm(removedChange, { recursive: true });
  assert.deepEqual((await scanRoot(root)).changes.map(change => change.id), ['first']);
});

test('scanning and opening documents leave the selected tree unchanged', async t => {
  const { root } = await fixture(t, {
    'openspec/config.yaml': 'schema: spec-driven\n',
    'openspec/changes/read-only/tasks.md': '# Tasks\n- [ ] Review\n',
    'README.md': '# Read only\n\n**Document** content.\n',
    '.git/config': '[core]\nrepositoryformatversion = 0\n',
  });
  const before = await treeDigest(root);
  await scanRoot(root);
  const document = await readDocument(root, 'README.md');
  assert.equal(normalized(document.path), 'README.md');
  assert.ok(document.title);
  assert.match(document.html, /<strong>Document<\/strong>/);
  assert.ok(document.modifiedAt);
  assert.deepEqual(await treeDigest(root), before);
});

test('an invalid inventory produces warnings while readable content remains available', async t => {
  const { root } = await fixture(t, {
    'openspec/config.yaml': 'schema: spec-driven\n',
    'openspec/changes/readable/proposal.md': '# Still readable\n',
    'repositorios.json': '{ "repositories": [ this is invalid JSON',
  });
  const result = await scanRoot(root);
  assert.equal(result.changes[0].id, 'readable');
  assert.ok(result.warnings.length > 0);
  assert.deepEqual(result.repositories, []);
});

test('documents larger than 1 MiB are rejected and reported without breaking the scan', async t => {
  const { root } = await fixture(t, {
    'openspec/config.yaml': 'schema: spec-driven\n',
    'openspec/changes/large/tasks.md': 'x'.repeat(1024 * 1024 + 1),
    'README.md': '# Small\n',
  });
  await assert.rejects(readDocument(root, 'openspec/changes/large/tasks.md'), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /large|limit|size|MiB|MB|tamañ|grande|límite/i);
    return true;
  });
  const result = await scanRoot(root);
  assert.ok(result.warnings.length > 0);
  assert.ok(documentPaths(result.docs).includes('README.md'));
});

test('a selected root must contain recognizable OpenSpec structure', async t => {
  const { root } = await fixture(t, { 'README.md': '# Ordinary project\n' });
  await assert.rejects(scanRoot(root));
  await mkdir(path.join(root, 'openspec'));
  await assert.rejects(scanRoot(root));
  await mkdir(path.join(root, 'openspec', 'specs'));
  assert.deepEqual((await scanRoot(root)).changes, []);
});

test('document access rejects traversal, absolute paths, and non-Markdown files', async t => {
  const { fixtureRoot, root } = await fixture(t, {
    'openspec/config.yaml': 'schema: spec-driven\n',
    'README.md': '# Allowed\n',
    'secret.txt': 'Not a document\n',
  });
  const outside = path.join(fixtureRoot, 'outside.md');
  await writeFile(outside, '# Outside\n');
  for (const candidate of ['../outside.md', 'docs/../../outside.md', '..\\outside.md', outside, path.join(root, 'README.md'), 'secret.txt']) {
    await assert.rejects(readDocument(root, candidate), undefined, `Must reject ${candidate}`);
  }
});

test('directory links are ignored by scans and cannot escape document access', async t => {
  const { fixtureRoot, root } = await fixture(t, {
    'openspec/config.yaml': 'schema: spec-driven\n',
    'docs/local.md': '# Local\n',
  });
  const external = path.join(fixtureRoot, 'external');
  await mkdir(external);
  await writeFile(path.join(external, 'private.md'), '# Outside selected root\n');
  const link = path.join(root, 'docs', 'external');
  try {
    await symlink(external, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`This Windows environment cannot create a directory junction: ${error.code}`);
      return;
    }
    throw error;
  }
  const result = await scanRoot(root);
  assert.deepEqual(documentPaths(result.docs), ['docs/local.md']);
  await assert.rejects(readDocument(root, 'docs/external/private.md'));
});

test('a junction at openspec/changes cannot expose an external archive', async t => {
  const { fixtureRoot, root } = await fixture(t, {
    'openspec/config.yaml': 'schema: spec-driven\n',
    'README.md': '# Local project\n',
  });
  const external = path.join(fixtureRoot, 'external-changes');
  const archived = path.join(external, 'archive', 'external-change');
  await mkdir(archived, { recursive: true });
  await writeFile(path.join(archived, 'proposal.md'), '# External archive\n');
  try {
    await symlink(external, path.join(root, 'openspec', 'changes'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`This Windows environment cannot create a directory junction: ${error.code}`);
      return;
    }
    throw error;
  }
  const result = await scanRoot(root);
  assert.deepEqual(result.changes, []);
  await assert.rejects(readDocument(root, 'openspec/changes/archive/external-change/proposal.md'));
});

const proposal = [
  '# Buscar en el catálogo',
  '',
  '> Simulación de prueba.',
  '',
  '## Por qué',
  '',
  'Encontrar un recurso exige recorrer la lista. Es lento.',
  '',
  '## Qué cambia',
  '',
  'Agregar una búsqueda por nombre. Además, explicar cuándo no hay coincidencias.',
  '',
  '| Situación | Comportamiento |',
  '| --- | --- |',
  '| Texto vacío | Mostrar todo |',
  '',
  '## Capacidades',
  '',
  '- Modificada: `catalog`.',
  '',
  '## Impacto',
  '',
  '`catalog-web` y catalog-api cambian; catalog-api-legacy no. Ver [contrato](contracts/catalog.openapi.yaml) y [mapa](../../../docs/map.md).',
  '',
  '## Fuera de alcance',
  '',
  'Ordenación avanzada. No se prevén cambios en contratos.',
].join('\n');

test('the proposal summary extracts the expected sections, purpose, contracts and related components', async t => {
  const { root } = await fixture(t, {
    'openspec/config.yaml': 'schema: spec-driven\n',
    'openspec/changes/search/proposal.md': proposal,
    'openspec/changes/search/specs/catalog/spec.md': '# Delta\n\n## ADDED Requirements\n\n### Requirement: Buscar\n\n#### Scenario: Coincide\n\n- **WHEN** x\n\n#### Scenario: Vacío\n\n- **WHEN** y\n\n## MODIFIED Requirements\n\n### Requirement: Listar\n\n#### Scenario: Lista\n',
    'openspec/changes/search/specs/export/spec.md': '# Nueva capacidad\n',
    'openspec/changes/search/revision.md': '# Revisión\n',
    'openspec/specs/catalog/spec.md': '# Catálogo canónico\n',
    'docs/map.md': '# Mapa del sistema\n',
    'docs/guia-hu.md': '# Guía de HU\n',
    'repositorios.json': JSON.stringify({ system: 'Demo', repositories: [{ id: 'catalog-web', role: 'Interfaz' }, { id: 'catalog-api', role: 'Servicio' }, { id: 'catalog-data', role: 'Datos' }] }),
  });
  const result = await scanRoot(root);
  const change = result.changes.find(item => item.id === 'search');
  assert.deepEqual(change.summary.sections.map(section => section.label), ['Por qué', 'Qué cambia', 'Capacidades', 'Impacto', 'Fuera de alcance']);
  assert.equal(change.summary.hasImpact, true);
  assert.equal(change.purpose, 'Agregar una búsqueda por nombre.');
  assert.match(change.summary.sections[1].html, /<table>/);
  assert.equal(change.folder, 'openspec/changes/search');
  assert.equal(change.revision, true);
  assert.deepEqual(change.related.map(item => item.id), ['catalog-web', 'catalog-api']);
  assert.deepEqual(change.contracts, ['contracts/catalog.openapi.yaml']);
  assert.deepEqual(change.capabilities.sort(), ['catalog', 'export']);
  assert.deepEqual(change.canonical, ['openspec/specs/catalog/spec.md']);
  assert.deepEqual(change.context, ['docs/map.md', 'docs/guia-hu.md']);
  const delta = change.documents.find(item => item.path === 'openspec/changes/search/specs/catalog/spec.md').delta;
  assert.deepEqual(delta, { added: 1, modified: 1, removed: 0, renamed: 0, scenarios: 3 });
  assert.equal(result.rootMarker, 'openspec/config.yaml');
  assert.equal(result.specs[0].title, 'Catálogo canónico');
  assert.equal(result.docs.find(item => item.path === 'docs/map.md').title, 'Mapa del sistema');
  assert.equal(result.intents, null);
});

test('English OpenSpec proposal headings are recognised and missing sections stay absent', () => {
  const summary = proposalSummary('# Change\n\n## Why\n\nBecause lists grow. More text.\n\n## What Changes\n\n- Add search\n\n## Impact\n\nNone.\n');
  assert.deepEqual(summary.sections.map(section => section.key), ['why', 'what', 'impact']);
  // "What Changes" has no top-level paragraph, so the purpose falls back to its plain text.
  assert.equal(summary.purpose, 'Add search');
  assert.deepEqual(proposalSummary('# Sin secciones\n\nTexto.\n'), { sections: [], purpose: '' });
});

test('related components match whole repository ids only', () => {
  const repositories = [{ id: 'api', role: 'Servicio' }, { id: 'web', role: 'Interfaz' }, { id: 'api-v2', role: 'Nuevo' }];
  assert.deepEqual(relatedComponents('Cambia `api-v2` y la webapp.', repositories).map(item => item.id), ['api-v2']);
  assert.deepEqual(relatedComponents('Afecta a api, no a otras.', repositories).map(item => item.id), ['api']);
  assert.deepEqual(relatedComponents('', repositories), []);
});

test('contract references come from links and code spans, not from prose', () => {
  assert.deepEqual(contractReferences('No cambian los contratos.\n\nVer `orders.proto` y [API](docs/openapi.yaml).\n\n```\ncontract.json\n```'), ['docs/openapi.yaml', 'orders.proto']);
});

test('next step rules are deterministic and always explain their basis', () => {
  const change = (present, tasks = { done: 0, total: 0 }, extra = {}) => ({
    archived: false, revision: false, tasks,
    artifacts: ['proposal', 'specs', 'design', 'tasks'].map(id => ({ id, present: present.includes(id) })),
    ...extra,
  });
  assert.equal(nextStep(change([])).title, 'Generar la propuesta');
  const specs = nextStep(change(['proposal']));
  assert.equal(specs.title, 'Generar specs');
  assert.deepEqual(specs.basis, ['Sin carpeta specs/ en el cambio', 'design.md y tasks.md no existen']);
  assert.equal(nextStep(change(['proposal', 'specs'])).title, 'Generar diseño y tareas');
  assert.equal(nextStep(change(['proposal', 'specs', 'design'])).title, 'Generar tareas');
  const pending = nextStep(change(['proposal', 'specs', 'design', 'tasks'], { done: 3, total: 9 }, { revision: true }));
  assert.equal(pending.title, 'Continuar tareas pendientes');
  assert.match(pending.detail, /6 casillas sin marcar/);
  assert.deepEqual(pending.basis, ['tasks.md: 3 de 9 casillas marcadas', 'revision.md presente; contenido no verificado']);
  const complete = nextStep(change(['proposal', 'specs', 'tasks'], { done: 4, total: 4 }));
  assert.equal(complete.title, 'Revisar antes de archivar');
  assert.doesNotMatch(complete.detail, /probad|aprobad/i);
  assert.equal(nextStep(change(['proposal', 'specs', 'tasks'])).title, 'Revisar tasks.md');
  assert.equal(nextStep(change(['proposal'], undefined, { archived: true })).title, 'Consultar las specs consolidadas');
  for (const step of [nextStep(change([])), specs, pending, complete]) assert.ok(step.basis.length > 0);
});

test('docs/INDICE.md intentions resolve their first link against the S0 index', async t => {
  const { root } = await fixture(t, {
    'openspec/specs/catalog/spec.md': '# Catálogo\n',
    'docs/INDICE.md': '# Índice\n\n## Comprender la arquitectura\n\nComponentes y relaciones.\n\n- Ver [mapa](sistema.md) y [otro](otro.md).\n\n## Consultar una pantalla\n\nSpecs por pantalla.\n\n[catálogo](../openspec/specs/catalog/)\n\n## Revisar contratos\n\nSin documento todavía.\n\n## Enlace roto\n\nApunta a un archivo inexistente.\n\n[falta](no-existe.md)\n',
    'docs/sistema.md': '# Sistema\n',
  });
  const result = await scanRoot(root);
  assert.equal(result.rootMarker, 'openspec/specs');
  assert.deepEqual(result.intents.map(({ title, description, path }) => ({ title, description, path })), [
    { title: 'Comprender la arquitectura', description: 'Componentes y relaciones.', path: 'docs/sistema.md' },
    { title: 'Consultar una pantalla', description: 'Specs por pantalla.', path: 'openspec/specs/catalog/spec.md' },
    { title: 'Revisar contratos', description: 'Sin documento todavía.', path: null },
    { title: 'Enlace roto', description: 'Apunta a un archivo inexistente.', path: null },
  ]);
  assert.equal(result.intents[2].href, null);
  assert.equal(result.intents[3].href, 'no-existe.md');
  assert.deepEqual(parseIntents('Sin encabezados.'), []);
});

test('documents expose their heading outline and large files can still be located for the editor', async t => {
  const { root } = await fixture(t, {
    'openspec/config.yaml': 'schema: spec-driven\n',
    'docs/guide.md': '# Guía\n\n## Uso\n\n### Detalle `x`\n\n#### Caso\n\n##### Nota\n',
    'docs/large.md': '# Grande\n' + 'x'.repeat(1024 * 1024 + 1),
  });
  const document = await readDocument(root, 'docs/guide.md');
  assert.deepEqual(document.headings, [{ id: 'uso', text: 'Uso', level: 2 }, { id: 'detalle-x', text: 'Detalle x', level: 3 }, { id: 'caso', text: 'Caso', level: 4 }]);
  assert.match(document.html, /<h2 id="uso">/);
  await assert.rejects(readDocument(root, 'docs/large.md'));
  assert.equal(await realpath(await locateDocument(root, 'docs/large.md')), await realpath(path.join(root, 'docs/large.md')));
  await assert.rejects(locateDocument(root, '../outside.md'));
  assert.equal(await realpath(await locateDocument(root, 'openspec/config.yaml')), await realpath(path.join(root, 'openspec/config.yaml')));
  await assert.rejects(locateDocument(root, 'arbitrary.yaml'));
});

test('relative links resolve inside the document tree and ignore external destinations', () => {
  assert.equal(resolveLink('openspec/changes/a/proposal.md', '../../../docs/map.md#top'), 'docs/map.md');
  assert.equal(resolveLink('docs/INDICE.md', './sub/b.md'), 'docs/sub/b.md');
  assert.equal(resolveLink('README.md', '../outside.md'), null);
  for (const href of ['https://example.test', '#anchor', '/abs.md', 'mailto:x@example.test', '']) assert.equal(resolveLink('docs/a.md', href), null);
});

test('context description reads only an explicit literal YAML context block', () => {
  assert.equal(contextDescription('schema: spec-driven\ncontext: |\n\n  Catalog service.\n  Second line.\nrules:\n  tasks: []'), 'Catalog service.');
  assert.equal(contextDescription('\uFEFFcontext: |- # brief context\r\n  A system with <tags>.\r\n'), 'A system with <tags>.');
  for (const source of ['context: pending', 'rules:\n  context: |\n    Nested value', 'context: |\nrules:\n  context: no', 'context: >\n  Folded text', 'context: |\n']) assert.equal(contextDescription(source), null);
});

test('archive dates must be complete real dates rather than current time or filesystem timestamps', () => {
  assert.equal(archiveDate('2024-02-29-change'), '2024-02-29');
  assert.equal(archiveDate('2026-10-07'), '2026-10-07');
  for (const name of ['2026-02-29-change', '2026-13-01-change', '2026-04-31-change', 'draft-2026-10-07', '2026-10-07suffix', 'change']) assert.equal(archiveDate(name), null);
});

test('snapshot reports actual template files, valid archive dates and first context line', async t => {
  const { root } = await fixture(t, {
    'openspec/config.yml': 'schema: spec-driven\ncontext: |\n  Fictional catalog for tests.\n  More detail.\n',
    'openspec/changes/archive/2026-09-15-old/proposal.md': '# Old\n',
    'openspec/changes/archive/2026-02-30-invalid/proposal.md': '# Invalid\n',
    'docs/INDICE.md': '# Index\n',
    'docs/trabajar-hu.md': '# Guide\n',
    'AGENTS.md': '# Rules\n',
    'repositorios.json': JSON.stringify({ system: 'Test system', repositories: [] }),
  });
  const snapshot = await scanRoot(root);
  assert.equal(snapshot.description, 'Fictional catalog for tests.');
  assert.deepEqual(snapshot.template, { config: true, indice: true, repositorios: true, readme: false, agents: true, guide: true });
  assert.equal(snapshot.changes.find(change => change.id.includes('09-15')).archivedAt, '2026-09-15');
  assert.equal(snapshot.changes.find(change => change.id.includes('02-30')).archivedAt, null);
});

test('structured documents and capability catalog connect current deltas with consolidated specs', async t => {
  const { root } = await fixture(t, {
    'openspec/config.yaml': 'schema: spec-driven\n',
    'openspec/changes/search/proposal.md': '# Search\n',
    'openspec/changes/search/specs/catalog/spec.md': '## ADDED Requirements\n\n### Requirement: Query\n\nThe system SHALL query.\n\n#### Scenario: Match\n\n- **WHEN** matching\n- **THEN** list\n',
    'openspec/changes/search/tasks.md': '# Tasks\n\n## Verify\n\n- [x] Inspect\n- [ ] Test\n',
    'openspec/specs/catalog/spec.md': '# Catalog\n\n## Requirements\n\n### Requirement: List\n\nThe system MUST list.\n\n#### Scenario: Items\n\n- **WHEN** loaded\n- **THEN** shown\n\n#### Scenario: Empty\n\n- **WHEN** empty\n- **THEN** explain\n',
  });
  const snapshot = await scanRoot(root);
  const spec = snapshot.specs[0];
  assert.deepEqual(spec.specCounts, { requirements: 1, scenarios: 2 });
  assert.equal(spec.requirements, 1);
  assert.equal(spec.scenarios, 2);
  assert.deepEqual(spec.relatedChanges, [{ id: 'search', title: 'Search', archived: false }]);
  const delta = snapshot.changes[0].documents.find(document => document.kind === 'specs');
  assert.equal(delta.canonical, spec.path);
  assert.deepEqual(delta.specCounts, { requirements: 1, scenarios: 1 });
  const document = await readDocument(root, delta.path);
  assert.equal(document.specStructure.groups[0].requirements[0].title, 'Query');
  assert.equal(document.delta.added, 1);
  assert.equal(document.tasksStructure, null);
  const tasks = await readDocument(root, 'openspec/changes/search/tasks.md');
  assert.equal(tasks.specStructure, null);
  assert.equal(tasks.tasksStructure.total, 2);
  assert.equal(tasks.tasksStructure.done, 1);
  assert.equal(tasks.tasksStructure.sections[0].title, 'Verify');
});

test('the real template index table supports selective reading and broken links stay unavailable', async t => {
  const { root } = await fixture(t, {
    'openspec/config.yaml': 'schema: spec-driven\n',
    'docs/INDICE.md': '# Documentation\n\n## Read only what you need\n\n| Need | Start here | Scope |\n| --- | --- | --- |\n| Analyze a HU | [Guide](analizar-proyecto.md) | Before proposing |\n| Coding Go | [Go](coding/go.md) | Go components |\n| Pending | [Missing](missing.md) | No source |\n',
    'docs/analizar-proyecto.md': '# Analyze project\n',
    'docs/coding/go.md': '# Go guide\n',
  });
  const snapshot = await scanRoot(root);
  assert.deepEqual(snapshot.intents.map(intent => [intent.title, intent.path, intent.description]), [
    ['Analyze a HU', 'docs/analizar-proyecto.md', 'Before proposing'],
    ['Coding Go', 'docs/coding/go.md', 'Go components'],
    ['Pending', null, 'No source'],
  ]);
});

test('search finds body text and literal-safe snippets in active documents while honoring scopes', async t => {
  const { root } = await fixture(t, {
    'openspec/config.yaml': 'schema: spec-driven\n',
    'openspec/changes/search/proposal.md': '# Search\n\nA hidden NEEDLE inside prose. A needle repeated.\n',
    'openspec/changes/archive/2026-01-01-old/proposal.md': '# Archived needle\n',
    'openspec/specs/catalog/spec.md': '# Catalog\n\n### Requirement: Needle\n\nThe system SHALL list.\n',
    'docs/guide.md': '# Guide\n\nA needle with <script>alert(1)</script>.\n\n```md\nOnlyInFence\n```\n',
    'docs/oversized.md': '# Needle oversized\n' + 'x'.repeat(1024 * 1024),
    '.local/private.md': '# Needle secret\n',
  });
  const before = await treeDigest(root);
  const snapshot = await scanRoot(root);
  const results = await searchDocuments(root, snapshot, 'needle');
  assert.deepEqual(results.map(result => result.path).sort(), ['docs/guide.md', 'openspec/changes/search/proposal.md', 'openspec/specs/catalog/spec.md']);
  assert.equal(results.find(result => result.kind === 'proposal').count, 2);
  assert.match(results.find(result => result.kind === 'context').snippet, /<script>/);
  assert.equal((await searchDocuments(root, snapshot, 'needle', 'changes')).length, 1);
  assert.equal((await searchDocuments(root, snapshot, 'needle', 'specs')).length, 1);
  assert.equal((await searchDocuments(root, snapshot, 'needle', 'context')).length, 1);
  assert.match(searchWarnings(snapshot).join(' '), /1 MiB/);
  assert.deepEqual(await searchDocuments(root, snapshot, 'OnlyInFence'), []);
  assert.deepEqual(await searchDocuments(root, snapshot, '   '), []);
  assert.deepEqual((await searchDocuments(root, snapshot, 'needle', 'archive')).map(result => result.path), ['openspec/changes/archive/2026-01-01-old/proposal.md']);
  await assert.rejects(searchDocuments(root, snapshot, 'needle', 'invalid-scope'));
  await assert.rejects(searchDocuments(root, snapshot, 'x'.repeat(201)), /200 caracteres/);
  assert.deepEqual(await treeDigest(root), before);
});

test('the search index is memory bounded and explicitly reports partial results', async t => {
  const files = { 'openspec/config.yaml': 'schema: spec-driven\n' };
  const body = '# Search budget\n\nneedle ';
  const source = body + 'x'.repeat(1024 * 1024 - Buffer.byteLength(body));
  for (let index = 0; index < 33; index++) files[`docs/${String(index).padStart(2, '0')}.md`] = source;
  const { root } = await fixture(t, files);
  const snapshot = await scanRoot(root);
  assert.deepEqual(searchWarnings(snapshot), []);
  const results = await searchDocuments(root, snapshot, 'needle');
  assert.equal(results.length, 32);
  assert.match(searchWarnings(snapshot).join(' '), /32 MiB/);
  assert.doesNotMatch(JSON.stringify(snapshot), /needle/);
  const warnings = searchWarnings(snapshot);
  warnings.length = 0;
  assert.equal(searchWarnings(snapshot).length, 1);
});

test('search revalidates the S0 identity, bounds reads, excludes junctions and refreshes after rescanning', async t => {
  const { root, fixtureRoot, put } = await fixture(t, {
    'openspec/config.yaml': 'schema: spec-driven\n',
    'docs/local.md': '# Local\n\nOriginal token.\n',
  });
  const snapshot = await scanRoot(root);
  const foreign = path.join(fixtureRoot, 'foreign');
  await mkdir(path.join(foreign, 'openspec'), { recursive: true });
  await writeFile(path.join(foreign, 'openspec', 'config.yaml'), 'schema: spec-driven\n');
  await writeFile(path.join(foreign, 'private.md'), '# Private needle\n');
  await assert.rejects(searchDocuments(foreign, snapshot, 'Original'));
  snapshot.docs.push({ path: '../foreign/private.md', kind: 'context', title: 'Private' });
  try {
    await symlink(foreign, path.join(root, 'docs', 'external'), process.platform === 'win32' ? 'junction' : 'dir');
    snapshot.docs.push({ path: 'docs/external/private.md', kind: 'context', title: 'Private' });
  } catch (error) { if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error; }
  assert.deepEqual(await searchDocuments(root, snapshot, 'Private'), []);
  assert.equal((await searchDocuments(root, snapshot, 'Original')).length, 1);
  await put('docs/local.md', '# Local\n\nReplacement token.\n');
  const refreshed = await scanRoot(root);
  assert.deepEqual(await searchDocuments(root, refreshed, 'Original'), []);
  assert.equal((await searchDocuments(root, refreshed, 'Replacement')).length, 1);
});

test('the packaged demo exposes its actual tasks, structured spec and catalog links', async () => {
  const root = path.resolve(import.meta.dirname, '../demo');
  const snapshot = await scanRoot(root);
  const search = snapshot.changes.find(change => change.id === 'catalog-search');
  assert.ok(search);
  const tasks = await readDocument(root, search.documents.find(document => document.kind === 'tasks').path);
  assert.equal(tasks.tasksStructure.total, search.tasks.total);
  assert.equal(tasks.tasksStructure.done, search.tasks.done);
  const delta = await readDocument(root, search.documents.find(document => document.kind === 'specs').path);
  assert.ok(delta.specStructure.groups.length > 0);
  assert.ok(delta.specCounts.scenarios > 0);
  assert.ok(snapshot.specs[0].relatedChanges.some(change => change.id === 'catalog-search'));
  const design = search.documents.find(document => document.kind === 'design');
  assert.equal(design.diagramCount, 1);
  assert.equal((await readDocument(root, design.path)).diagramCount, 1);
});

test('concurrent searches remain consistent and reuse each scope until the snapshot changes', async t => {
  const { root, put } = await fixture(t, {
    'openspec/config.yaml': 'schema: spec-driven\n',
    'docs/guide.md': '# Guide\n\nNeedle documented.\n',
  });
  const snapshot = await scanRoot(root);
  const results = await Promise.all(Array.from({ length: 12 }, () => searchDocuments(root, snapshot, 'needle')));
  assert.ok(results.every(result => result.length === 1 && result[0].path === 'docs/guide.md'));
  await put('docs/guide.md', '# Guide\n\nReplacement.\n');
  assert.equal((await searchDocuments(root, snapshot, 'needle')).length, 1);
  assert.equal((await searchDocuments(root, snapshot, 'replacement', 'context')).length, 0);
  assert.equal((await searchDocuments(root, await scanRoot(root), 'replacement')).length, 1);
});

test('search discovery does not depend on paginated or faulty catalog metadata', async t => {
  const { root } = await fixture(t, { 'openspec/config.yaml': 'schema: spec-driven\n', 'docs/guide.md': '# Needle\n' });
  const snapshot = await scanRoot(root);
  Object.defineProperty(snapshot, 'docs', { get() { throw new Error('catalog metadata must not drive indexing'); } });
  await assert.rejects(searchDocuments(root, snapshot, 'needle', 'invalid-scope'));
  assert.equal((await searchDocuments(root, snapshot, 'needle')).length, 1);
});
