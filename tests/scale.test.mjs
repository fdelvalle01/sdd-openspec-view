import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanRoot, searchDocuments, searchWarnings, readDocument, locateDocument } from '../src/model.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openspec-viewer-scale-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('openspec-viewer-scale-'));
    await rm(root, { recursive: true, force: true });
  });
  async function put(file, source) {
    const destination = path.resolve(root, file);
    assert.ok(path.relative(root, destination) && !path.relative(root, destination).startsWith('..'));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, source);
  }
  async function many(entries) {
    for (let i = 0; i < entries.length; i += 32) await Promise.all(entries.slice(i, i + 32).map(([file, source]) => put(file, source)));
  }
  await put('openspec/config.yaml', 'schema: spec-driven\n');
  return { root, put, many };
}
const number = value => String(value).padStart(4, '0');

test('more than 2000 archived documents cannot hide current specs, context or index links', { timeout: 120000 }, async t => {
  const { root, put, many } = await fixture(t);
  await many(Array.from({ length: 2001 }, (_, i) => [`openspec/changes/archive/2026-01-01-old-${number(i)}/proposal.md`, `# Historical ${i}\n\nArchive needle.\n`]));
  await put('openspec/changes/current/proposal.md', '# Current\n');
  await put('openspec/specs/catalog/spec.md', '# Catalog\n\nCurrent needle.\n');
  await put('docs/INDICE.md', '# Index\n\n## Start\n\n[Guide](guide.md)\n');
  await put('docs/guide.md', '# Guide\n\nContext needle.\n');
  const snapshot = await scanRoot(root);
  assert.equal(snapshot.specs.length, 1);
  assert.ok(snapshot.docs.some(doc => doc.path === 'docs/guide.md'));
  assert.equal(snapshot.intents[0].path, 'docs/guide.md');
  assert.equal(snapshot.pagination.archive.loaded, 50);
  assert.equal(snapshot.pagination.archive.hasMore, true);
  assert.ok(snapshot.changes.filter(change => change.archived).every(change => change.loadState === 'unloaded' && change.documents.length === 0 && change.tasks === null && change.artifacts.every(artifact => artifact.present === null)));
  assert.deepEqual(searchWarnings(snapshot, 'archive'), []);
  const current = await searchDocuments(root, snapshot, 'needle');
  assert.equal(current.length, 2);
  assert.ok(current.every(result => result.scope !== 'archive'));
  const archiveId = 'archive/2026-01-01-old-2000';
  const opened = await scanRoot(root, { selectedChange: archiveId });
  const selected = opened.changes.find(change => change.id === archiveId);
  assert.equal(selected.loadState, 'loaded');
  assert.equal(selected.title, 'Historical 2000');
  assert.equal(selected.artifacts.find(artifact => artifact.id === 'tasks').present, false);
  assert.equal(opened.pagination.archive.ids.includes(archiveId), false);
  assert.equal(opened.pagination.archive.loaded, 50);
  assert.equal(opened.changes.filter(change => change.archived).length, 51);
  const archiveResults = await searchDocuments(root, snapshot, 'Archive needle', 'archive');
  assert.equal(archiveResults.length, 2000);
  assert.ok(archiveResults.every(result => result.scope === 'archive' && result.changeId.startsWith('archive/')));
  assert.match(searchWarnings(snapshot, 'archive').join(' '), /2000/);
  assert.deepEqual(searchWarnings(snapshot), []);
  assert.equal((await searchDocuments(root, snapshot, 'Archive needle')).length, 0);
});

test('2000 active documents cannot consume another catalog or search scope and pinned artifacts survive paging', { timeout: 120000 }, async t => {
  const { root, put, many } = await fixture(t);
  await many(Array.from({ length: 2001 }, (_, i) => [`openspec/changes/bulk/notes/${number(i)}.md`, '# Active needle\n']));
  await put('openspec/changes/bulk/proposal.md', '# Bulk proposal\n');
  await put('openspec/changes/bulk/design.md', '# Bulk design\n');
  await put('openspec/changes/bulk/tasks.md', '- [x] Keep pinned\n');
  await put('openspec/changes/bulk/revision.md', '# Decisions\n');
  await put('openspec/changes/bulk/specs/catalog/spec.md', '## ADDED Requirements\n### Requirement: Example\nThe system SHALL work.\n');
  await put('openspec/specs/catalog/spec.md', '# Canonical needle\n');
  await put('docs/guide.md', '# Context needle\n');
  const snapshot = await scanRoot(root);
  assert.equal(snapshot.specs.length, 1);
  assert.equal(snapshot.docs.length, 1);
  const bulk = snapshot.changes[0];
  assert.equal(bulk.documents.length, 104);
  assert.equal(bulk.documentPagination.hasMore, true);
  assert.equal(bulk.artifacts.find(artifact => artifact.id === 'specs').present, true, 'a delta beyond the current document page is present');
  assert.deepEqual(bulk.tasks, { total: 1, done: 1 });
  const results = await searchDocuments(root, snapshot, 'needle');
  assert.ok(results.some(result => result.scope === 'specs'));
  assert.ok(results.some(result => result.scope === 'context'));
  assert.match(searchWarnings(snapshot, 'changes').join(' '), /2000/);
  assert.deepEqual(searchWarnings(snapshot, 'specs'), []);
  assert.deepEqual(searchWarnings(snapshot, 'context'), []);
  const page = await scanRoot(root, { selectedChange: 'bulk', changePage: 20 });
  const selected = page.changes.find(change => change.id === 'bulk');
  assert.equal(selected.documentPagination.page, 20);
  assert.equal(selected.documentPagination.hasMore, false);
  assert.equal(selected.documentPagination.loaded, 2);
  for (const file of ['proposal.md', 'design.md', 'tasks.md', 'revision.md']) assert.ok(selected.documents.some(doc => doc.path === `openspec/changes/bulk/${file}`));
  assert.deepEqual(selected.tasks, { total: 1, done: 1 });
  assert.ok(selected.canonical.includes('openspec/specs/catalog/spec.md'));
  assert.ok(!selected.documents.some(doc => doc.path.endsWith('/0000.md')), 'new pages replace variable documents');
});

test('catalog pages have exact boundaries and search discovers documents beyond the visible page', async t => {
  const { root, put, many } = await fixture(t);
  await many(Array.from({ length: 101 }, (_, i) => [`docs/guide-${number(i)}.md`, `# Guide ${i}\n\nNeedle ${i}.\n`]));
  await many(Array.from({ length: 51 }, (_, i) => [`openspec/changes/current-${number(i)}/proposal.md`, `# Current ${i}\n`]));
  await many(Array.from({ length: 100 }, (_, i) => [`openspec/specs/spec-${number(i)}/spec.md`, `# Spec ${i}\n`]));
  const first = await scanRoot(root);
  assert.equal(first.pagination.context.loaded, 100);
  assert.equal(first.pagination.context.hasMore, true);
  assert.equal(first.pagination.specs.loaded, 100);
  assert.equal(first.pagination.specs.hasMore, false);
  assert.equal(first.pagination.specs.total, 100);
  assert.equal(first.pagination.specs.status, 'loaded');
  assert.equal(first.pagination.changes.loaded, 50);
  assert.equal(first.pagination.changes.hasMore, true);
  assert.ok(!first.docs.some(doc => doc.path === 'docs/guide-0100.md'));
  assert.equal((await searchDocuments(root, first, 'Needle 100', 'context'))[0].path, 'docs/guide-0100.md');
  const next = await scanRoot(root, { pages: { context: 1, changes: 1 } });
  assert.deepEqual(next.docs.map(doc => doc.path), ['docs/guide-0100.md']);
  assert.equal(next.pagination.context.total, 101);
  assert.equal(next.pagination.context.hasMore, false);
  assert.deepEqual(next.pagination.changes.ids, ['current-0050']);
  assert.equal(next.pagination.specs.page, 0);
  await put('docs/guide-0101.md', '# New\n');
  assert.equal((await scanRoot(root, { pages: { context: 1 } })).pagination.context.loaded, 2);
});

test('search limits distinguish exactly 1999, 2000 and 2001 documents without a false boundary warning', { timeout: 120000 }, async t => {
  const { root, put, many } = await fixture(t);
  await many(Array.from({ length: 1999 }, (_, i) => [`docs/${number(i)}.md`, '# Boundary needle\n']));
  for (const count of [1999, 2000, 2001]) {
    if (count > 1999) await put(`docs/${number(count - 1)}.md`, '# Boundary needle\n');
    const snapshot = await scanRoot(root, { pages: { context: Math.floor((count - 1) / 100) } });
    const results = await searchDocuments(root, snapshot, 'Boundary needle', 'context');
    assert.equal(results.length, Math.min(count, 2000));
    assert.equal(searchWarnings(snapshot, 'context').some(message => message.includes('2000')), count > 2000);
    assert.equal(snapshot.pagination.context.hasMore, false);
    assert.equal(snapshot.pagination.context.total, count);
    assert.equal(snapshot.pagination.context.status, 'loaded');
  }
});

test('content and search byte budgets are separate for current scopes and a selected HU', { timeout: 120000 }, async t => {
  const { root, put, many } = await fixture(t);
  const prefix = '# Payload\n\nByte needle.\n';
  const large = prefix + 'x'.repeat(1024 * 1024 - Buffer.byteLength(prefix));
  await many(Array.from({ length: 33 }, (_, i) => [`openspec/changes/a-large/notes/${number(i)}.md`, large]));
  await put('openspec/changes/z-small/proposal.md', '# Small\n');
  await put('openspec/changes/z-small/tasks.md', '- [ ] Small task\n');
  await put('openspec/specs/catalog/spec.md', '# Spec byte needle\n');
  await put('docs/guide.md', '# Context byte needle\n');
  const snapshot = await scanRoot(root);
  const largeChange = snapshot.changes.find(change => change.id === 'a-large');
  const small = snapshot.changes.find(change => change.id === 'z-small');
  assert.equal(largeChange.documents.filter(doc => doc.loadState === 'loaded').length, 32);
  assert.equal(largeChange.documents.filter(doc => doc.loadState === 'unloaded').length, 1);
  assert.equal(small.tasks, null);
  assert.equal(small.artifacts.find(artifact => artifact.id === 'tasks').present, true);
  assert.match(small.next.title, /lectura/);
  assert.match(snapshot.warnings.join(' '), /32 MiB/);
  const results = await searchDocuments(root, snapshot, 'byte needle');
  assert.ok(results.some(result => result.scope === 'specs'));
  assert.ok(results.some(result => result.scope === 'context'));
  assert.match(searchWarnings(snapshot, 'changes').join(' '), /32 MiB/);
  assert.deepEqual(searchWarnings(snapshot, 'context'), []);
  const selected = await scanRoot(root, { selectedChange: 'z-small' });
  assert.deepEqual(selected.changes.find(change => change.id === 'z-small').tasks, { total: 1, done: 0 });
  assert.equal(selected.changes.find(change => change.id === 'z-small').loadState, 'loaded');
});

test('page inputs, selected identities and case aliases cannot bypass document boundaries', async t => {
  const { root, put } = await fixture(t);
  await put('docs/.local/private.md', '# Private needle\n');
  await put('docs/.LOCAL/other.md', '# Private needle\n');
  await put('docs/public.md', '# Public\n');
  for (const invalid of [-1, 0.5, '1', Infinity, 1000001]) await assert.rejects(scanRoot(root, { pages: { context: invalid } }), /Página/);
  for (const invalid of ['../escape', '/absolute', 'archive', 'archive/../escape', 'archive/../../escape', 'C:/absolute', 'one\\two', '.local', 123]) await assert.rejects(scanRoot(root, { selectedChange: invalid }), /Identificador/);
  await assert.rejects(scanRoot(root, { pages: { unknown: 1 } }));
  await assert.rejects(scanRoot(root, { pages: [] }));
  for (const file of ['docs/.local/private.md', 'docs/.LOCAL/private.md', 'docs/.LOCAL/other.md']) {
    await assert.rejects(readDocument(root, file));
    await assert.rejects(locateDocument(root, file));
  }
  const snapshot = await scanRoot(root);
  assert.deepEqual(snapshot.docs.map(doc => doc.path), ['docs/public.md']);
  assert.deepEqual(await searchDocuments(root, snapshot, 'Private', 'context'), []);
  const missing = await scanRoot(root, { selectedChange: 'deleted-hu' });
  const change = missing.changes.find(item => item.id === 'deleted-hu');
  assert.equal(change.loadState, 'error');
  assert.ok(change.artifacts.every(artifact => artifact.present === null));
});

test('selected archive and off-page search do not follow directory links', async t => {
  const { root, put } = await fixture(t);
  await put('private/proposal.md', '# Private needle\n');
  await mkdir(path.join(root, 'openspec/changes/archive'), { recursive: true });
  try { await symlink(path.join(root, 'private'), path.join(root, 'openspec/changes/archive/linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Directory-link privileges unavailable.'); return; } throw error; }
  const snapshot = await scanRoot(root, { selectedChange: 'archive/linked' });
  assert.equal(snapshot.changes.find(change => change.id === 'archive/linked').loadState, 'error');
  assert.deepEqual(snapshot.pagination.archive.ids, []);
  assert.deepEqual(await searchDocuments(root, snapshot, 'Private', 'archive'), []);
  await assert.rejects(readDocument(root, 'openspec/changes/archive/linked/proposal.md'));
});
