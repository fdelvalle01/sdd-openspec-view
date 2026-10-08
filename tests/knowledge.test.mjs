import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import MarkdownIt from 'markdown-it';
import { createKnowledgeEngine } from '../scripts/conocimiento/index.mjs';
import { buildKnowledgeIndex } from '../src/knowledge.js';
import { renderDocument } from '../src/markdown.js';
import { locateDocument, readDocument } from '../src/model.js';
import { primaryNodes, incidentRelations, neighbourhood, sourceTarget, graphZone } from '../src/graph-model.js';

test('the bundled adapter and CLI factory produce exactly the same index and anchors', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'viewer-graph-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [file, source] of Object.entries({
    'openspec/config.yaml': 'schema: spec-driven\n',
    'README.md': '# S0\n\n[Contexto](docs/context.md#decisión-uno)\n',
    'docs/context.md': '# Contexto inicial\n\n## Decisión [uno](../README.md)\n\n## Decisión uno\n\n- [ ] 1.1 Comprobar evidencia\n',
    'openspec/changes/archive/2026-01-01-old/proposal.md': '# Historia\n',
  })) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), source); }
  const engine = createKnowledgeEngine(MarkdownIt);
  const cli = await engine.buildIndex(root);
  const viewer = await buildKnowledgeIndex(root);
  assert.deepEqual(viewer, cli);
  assert.equal(viewer.coverage.archive.status, 'excluded');
  assert.ok(viewer.nodes.some(node => node.path === 'docs/context.md'));
  const source = '## Decisión [uno](../README.md)\n\n## Decisión uno\n\n- [ ] Tarea\n';
  const headings = engine.parseMarkdown(source).headings;
  assert.deepEqual(renderDocument(source).headings.map(item => item.id), headings.map(item => item.anchor));
  assert.match(renderDocument(source).html, /id="task-line-5"/);
  assert.ok((await buildKnowledgeIndex(root, { includeArchive: true })).nodes.some(node => node.path?.includes('/archive/')));
});

test('graph navigation retains all relation types, directions and evidence', () => {
  const nodes = [{ id: 'a', kind: 'document', path: 'docs/a.md', label: 'A', scope: 'context' }, { id: 'b', kind: 'document', path: 'docs/b.md', label: 'B', scope: 'context' }];
  const edges = [
    { id: 'out', from: 'a', to: 'b', type: 'link', origin: 'explicit', evidence: [{ path: 'docs/a.md', line: 3 }] },
    { id: 'in', from: 'b', to: 'a', type: 'reference', origin: 'explicit', evidence: [{ path: 'docs/b.md', line: 7 }] },
    { id: 'inferred', from: 'a', to: 'b', type: 'mention', origin: 'inferred', inferred: true, evidence: [] },
  ];
  assert.deepEqual(incidentRelations({ nodes, edges }, 'a').map(row => [row.edge.id, row.direction]), [['out', 'out'], ['in', 'in']]);
  assert.equal(incidentRelations({ nodes, edges }, 'a', { includeInferred: true }).length, 3);
  assert.deepEqual(neighbourhood({ nodes, edges }, 'a').edges.map(edge => edge.id), ['out', 'in']);
});

test('graph zones and neighbour pages bound visuals without dropping index relationships', () => {
  const focus = { id: 'hu', kind: 'change', label: 'HU', scope: 'changes' };
  const nodes = [focus, ...Array.from({ length: 205 }, (_, i) => ({ id: `n${String(i).padStart(3, '0')}`, kind: 'document', scope: 'changes', label: `Doc ${i}`, path: `openspec/changes/hu/${i}.md` }))];
  const edges = nodes.slice(1).map(item => ({ from: focus.id, to: item.id, type: 'contains', origin: 'structural' }));
  const index = { nodes, edges };
  assert.equal(primaryNodes(index, 'changes').length, 1);
  assert.equal(neighbourhood(index, 'hu').nodes.length, 101);
  assert.equal(neighbourhood(index, 'hu', { page: 2 }).nodes.length, 6);
  assert.equal(neighbourhood(index, 'hu').total, 205);
  assert.equal(index.edges.length, 205);
  assert.equal(graphZone({ kind: 'capability', scope: 'changes' }), 'specs');
  assert.equal(graphZone({ kind: 'document', path: 'CLAUDE.md', scope: 'tools' }), 'template');
  assert.deepEqual(sourceTarget({ kind: 'capability', state: 'proposed', path: 'openspec/changes/new/specs/nested/cap/spec.md', line: 3 }), { path: 'openspec/changes/new/specs/nested/cap/spec.md', line: 3 });
  assert.equal(sourceTarget({ kind: 'change', path: 'openspec/changes/new' }), null);
  assert.equal(sourceTarget({ kind: 'resource', path: 'other.json' }), null);
  assert.equal(sourceTarget({ kind: 'document', path: 'docs/.local./secret.md' }), null);
});

test('document reading and editor access reject Windows aliases of excluded directories', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'viewer-alias-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'docs', '.local'), { recursive: true });
  await writeFile(path.join(root, 'docs', '.local', 'secret.md'), '# Private\n');
  for (const file of ['docs/.local./secret.md', 'docs/.LOCAL /secret.md', 'docs/node_modules /secret.md', 'docs/NUL.md', 'docs/.aws/key.md']) {
    await assert.rejects(readDocument(root, file), /privadas|ambiguos/);
    await assert.rejects(locateDocument(root, file), /privadas|ambiguos/);
  }
});
