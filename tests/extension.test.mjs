import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { transform } from 'esbuild';
import { resolveRootInput } from '../src/root-selection.js';
import { scanRoot } from '../src/model.js';
import { buildKnowledgeIndex } from '../src/knowledge.js';

// Exercise the extension's real handlers with controlled async boundaries. No
// VS Code installation, fixture filesystem or production bundle is modified.
const filename = new URL('../src/extension.js', import.meta.url);
const source = await readFile(filename, 'utf8');
const { code } = await transform(source, { format: 'cjs', platform: 'node', target: 'node22' });
const nativeRequire = createRequire(import.meta.url);
const rootA = path.resolve('fixture-s0-a');
const rootB = path.resolve('fixture-s0-b');
const scopes = ['changes', 'archive', 'specs', 'context'];
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const disposable = () => ({ dispose() {} });
const document = relative => ({ path: relative, title: relative, html: '<p>Fixture</p>', headings: [] });
const plain = value => JSON.parse(JSON.stringify(value));

function snapshot(root, options = {}) {
  const pagination = Object.fromEntries(scopes.map(scope => [scope, {
    page: options.pages?.[scope] ?? 0, pageSize: scope === 'specs' || scope === 'context' ? 100 : 50,
    loaded: 0, hasMore: true, status: 'loaded',
  }]));
  return { rootPath: root, rootName: path.basename(root), changes: [], specs: [], docs: [], repositories: [], intents: [], warnings: [], pagination };
}

function harness(t, options = {}) {
  const messages = [];
  const errors = [];
  const opened = [];
  const shown = [];
  const scanCalls = [];
  const commands = new Map();
  const panels = [];
  const state = new Map();
  const behavior = {
    resolveRoot: async value => value,
    scan: async (root, options) => snapshot(root, options),
    read: async (_root, relative) => document(relative),
    locate: async (root, relative) => path.join(root, relative),
    search: async () => [],
    graph: async root => ({ schemaVersion: 1, rootPath: root, revision: 'fixture', nodes: [], edges: [], coverage: {}, diagnostics: [] }),
    openTextDocument: async value => ({ uri: value }),
    persist: async (key, value) => { state.set(key, value); },
    publish: async () => {},
  };
  const uri = value => ({ fsPath: options.windowsUri ? value.replace(/^([A-Z]):/, (_, drive) => `${drive.toLowerCase()}:`) : value, scheme: 'file', toString: () => value });
  const vscode = {
    Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)), parse: uri },
    ViewColumn: { Active: 1, Beside: 2 },
    RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
    Range: class { constructor(startLine, startCharacter, endLine, endCharacter) { Object.assign(this, { startLine, startCharacter, endLine, endCharacter }); } },
    commands: {
      registerCommand(id, callback) { commands.set(id, callback); return disposable(); },
    },
    workspace: {
      workspaceFolders: [],
      getConfiguration: () => ({ get: (_key, fallback) => fallback }),
      onDidChangeConfiguration: disposable,
      createFileSystemWatcher: () => ({ dispose() {}, onDidCreate: disposable, onDidChange: disposable, onDidDelete: disposable }),
      async openTextDocument(value) { opened.push(value.fsPath); return behavior.openTextDocument(value); },
    },
    window: {
      showErrorMessage: message => errors.push(message),
      showTextDocument: async value => shown.push(value.uri.fsPath),
      createWebviewPanel(_type, _title, _column, options) {
        let listener;
        let onDispose;
        const panel = {
          options, reveal() {},
          onDidDispose(callback) { onDispose = callback; return disposable(); },
          dispose() { onDispose?.(); },
          receive: message => listener(message),
          webview: {
            cspSource: 'vscode-resource:', asWebviewUri: value => value.toString(),
            postMessage: async message => { messages.push(plain(message)); await behavior.publish(message); return true; },
            onDidReceiveMessage(callback) { listener = callback; return disposable(); },
          },
        };
        panels.push(panel);
        return panel;
      },
    },
    env: { openExternal: async () => {}, clipboard: { writeText: async () => {} } },
  };
  const model = {
    isOpenSpecRoot: async () => true,
    scanRoot: (root, options) => { scanCalls.push({ root, options: plain(options) }); return behavior.scan(root, options); },
    readDocument: (...args) => behavior.read(...args),
    locateDocument: (...args) => behavior.locate(...args),
    searchDocuments: (...args) => behavior.search(...args),
    searchWarnings: (_snapshot, scope) => [`warnings for ${scope}`],
  };
  const module = { exports: {} };
  const context = {
    extensionUri: uri(options.extensionRoot || path.resolve('fixture-extension')),
    subscriptions: [],
    workspaceState: { get: (key, fallback) => state.get(key) ?? fallback, update: (key, value) => behavior.persist(key, value) },
  };
  vm.runInNewContext(code, {
    module, exports: module.exports, setTimeout, clearTimeout, console,
    require(id) {
      if (id === 'vscode') return vscode;
      if (id === './model.js') return model;
      if (id === './knowledge.js') return { buildKnowledgeIndex: (...args) => behavior.graph(...args) };
      if (id === './root-selection.js') return { INVALID_ROOT: 'INVALID_ROOT', resolveRootInput: (...args) => behavior.resolveRoot(...args) };
      return nativeRequire(id);
    },
  }, { filename: filename.pathname });
  const api = module.exports.activate(context);
  t.after(() => context.subscriptions.forEach(item => item.dispose()));
  return { api, behavior, messages, errors, opened, shown, panels, scanCalls, state,
    open: root => commands.get('sddWorkspaceViewer.open')(root),
    demo: () => commands.get('sddWorkspaceViewer.demo')(),
    receive: message => panels.at(-1).receive(message),
  };
}

async function rootFixture(t) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'openspec-protocol-'));
  t.after(async () => {
    const safe = path.resolve(temporary);
    assert.equal(path.dirname(safe), path.resolve(os.tmpdir()));
    assert.ok(path.basename(safe).startsWith('openspec-protocol-'));
    await rm(safe, { recursive: true, force: true });
  });
  return temporary;
}

async function createS0(root) {
  await mkdir(path.join(root, 'openspec'), { recursive: true });
  await mkdir(path.join(root, 'docs'));
  await writeFile(path.join(root, 'openspec/config.yaml'), 'schema: spec-driven\n');
  await writeFile(path.join(root, 'README.md'), '# Sistema\n\n[Contexto](docs/INDICE.md)\n');
  await writeFile(path.join(root, 'docs/INDICE.md'), '# Contexto\n');
  return realpath(root);
}

function useRealRootAndGraph(h) {
  h.behavior.resolveRoot = resolveRootInput;
  h.behavior.scan = scanRoot;
  h.behavior.graph = buildKnowledgeIndex;
}

test('Windows snapshot graph requests pass the actual host message handler with canonical root identity', { skip: process.platform !== 'win32' }, async t => {
  const temporary = await rootFixture(t);
  const canonical = await createS0(path.join(temporary, 'S0'));
  const lowerDrive = canonical.replace(/^([A-Z]):/, (_, drive) => `${drive.toLowerCase()}:`);
  const h = harness(t);
  useRealRootAndGraph(h);
  await h.open(lowerDrive);
  const snapshotRoot = h.api.getState().snapshot.rootPath;
  assert.equal(snapshotRoot, canonical);
  await h.receive({ type: 'graph', requestId: 41, rootPath: snapshotRoot });
  const graph = h.messages.find(message => message.type === 'graph' && message.requestId === 41);
  assert.ok(graph, 'the message bridge must answer graph requests built from the published snapshot');
  assert.equal(graph.rootPath, snapshotRoot);
  assert.equal(graph.index.rootPath, snapshotRoot);
  assert.ok(graph.index.nodes.some(node => node.path === 'docs/INDICE.md'));
  assert.equal(graph.error, undefined);
  const before = h.messages.length;
  await h.receive({ type: 'graph', requestId: 42, rootPath: path.join(temporary, 'other-S0') });
  assert.equal(h.messages.length, before, 'canonicalizing selected roots must not accept messages for a different S0');
  assert.deepEqual(h.errors, []);
});

test('Windows demo stays fictitious, is not persisted, and serves graph requests through its snapshot', { skip: process.platform !== 'win32' }, async t => {
  const temporary = await rootFixture(t);
  const canonical = await createS0(path.join(temporary, 'demo'));
  const h = harness(t, { extensionRoot: temporary, windowsUri: true });
  useRealRootAndGraph(h);
  await h.demo();
  const snapshot = h.api.getState().snapshot;
  assert.equal(snapshot.rootPath, canonical);
  assert.equal(snapshot.demo, true, 'physical path normalization must preserve the demo label');
  assert.equal(h.state.get('sddWorkspaceViewer.root'), undefined, 'an installed demo must not become the persisted user S0');
  await h.receive({ type: 'graph', requestId: 43, rootPath: snapshot.rootPath });
  const graph = h.messages.find(message => message.type === 'graph' && message.requestId === 43);
  assert.ok(graph, 'opening the demo graph must produce a response instead of leaving the loading state indefinitely');
  assert.equal(graph.rootPath, canonical);
  assert.ok(graph.index.nodes.length > 0);
  assert.deepEqual(h.errors, []);
});

test('the latest root request wins even when an earlier root resolves or rejects later', async t => {
  for (const outcome of ['resolve', 'reject']) await t.test(outcome, async t => {
    const h = harness(t);
    const pending = deferred();
    h.behavior.resolveRoot = value => value === rootA ? pending.promise : Promise.resolve(value);
    const older = h.open(rootA);
    await h.open(rootB);
    const published = h.messages.length;
    if (outcome === 'resolve') pending.resolve(rootA); else pending.reject(new Error('Old root unavailable'));
    await older;
    assert.equal(h.api.getState().snapshot.rootPath, rootB);
    assert.equal(h.messages.length, published, 'The old root cannot publish a snapshot or an error.');
    assert.deepEqual(h.errors, []);
    assert.ok(h.scanCalls.every(call => call.root === rootB));
  });
});

test('a persistence failure for an older root does not report an error after another root is selected', async t => {
  const h = harness(t);
  const enteredPersistence = deferred();
  const pending = deferred();
  h.behavior.persist = async (_key, value) => {
    if (value === rootA) { enteredPersistence.resolve(); return pending.promise; }
  };
  const older = h.open(rootA);
  await enteredPersistence.promise;
  const enteredNewRoot = deferred();
  h.behavior.publish = async message => {
    if (message.type === 'snapshot' && message.snapshot.rootPath === rootB) enteredNewRoot.resolve();
  };
  const latest = h.open(rootB);
  await enteredNewRoot.promise;
  pending.reject(new Error('Old root persistence failed'));
  await Promise.all([older, latest]);
  assert.equal(h.api.getState().snapshot.rootPath, rootB);
  assert.deepEqual(h.messages.filter(message => message.type === 'error'), []);
  assert.deepEqual(h.errors, []);
});

test('reads from an obsolete root publish neither success nor error into the current panel', async t => {
  for (const outcome of ['resolve', 'reject']) await t.test(outcome, async t => {
    const h = harness(t);
    await h.open(rootA);
    const pending = deferred();
    h.behavior.read = root => root === rootA ? pending.promise : Promise.resolve(document('docs/new.md'));
    const older = h.receive({ type: 'read', path: 'docs/old.md' });
    await h.open(rootB);
    await h.api.read('docs/new.md');
    const published = h.messages.length;
    if (outcome === 'resolve') pending.resolve(document('docs/old.md')); else pending.reject(new Error('Old document unreadable'));
    await older;
    assert.equal(h.api.getState().document.path, 'docs/new.md');
    assert.equal(h.messages.length, published);
    assert.deepEqual(h.errors, []);
  });
});

test('a newer page wins over slower success and failure of a previous page request', async t => {
  for (const outcome of ['resolve', 'reject']) await t.test(outcome, async t => {
    const h = harness(t);
    await h.open(rootA);
    const pending = deferred();
    h.behavior.scan = (root, options) => options.pages.specs === 1 ? pending.promise : Promise.resolve(snapshot(root, options));
    const older = h.receive({ type: 'page', scope: 'specs', page: 1 });
    await h.receive({ type: 'page', scope: 'specs', page: 2 });
    const published = h.messages.length;
    if (outcome === 'resolve') pending.resolve(snapshot(rootA, { pages: { specs: 1 } })); else pending.reject(new Error('Old page unreadable'));
    await older;
    assert.equal(h.api.getState().snapshot.pagination.specs.page, 2);
    assert.equal(h.api.getState().navigation.pages.specs, 2);
    assert.equal(h.messages.length, published);
    assert.deepEqual(h.errors, []);
  });
});

test('closing a panel invalidates pending detail loading before another panel is opened', async t => {
  for (const outcome of ['resolve', 'reject']) await t.test(outcome, async t => {
    const h = harness(t);
    await h.open(rootA);
    const pending = deferred();
    h.behavior.scan = (root, options) => root === rootA && options.selectedChange ? pending.promise : Promise.resolve(snapshot(root, options));
    const older = h.receive({ type: 'loadChange', id: 'archive/2026-10-08-old', page: 0 });
    h.panels.at(-1).dispose();
    await h.open(rootB);
    const published = h.messages.length;
    if (outcome === 'resolve') pending.resolve(snapshot(rootA)); else pending.reject(new Error('Disposed detail unreadable'));
    await older;
    assert.equal(h.api.getState().snapshot.rootPath, rootB);
    assert.equal(h.api.getState().navigation.selectedChange, null);
    assert.equal(h.messages.length, published);
    assert.deepEqual(h.errors, []);
  });
});

test('openSource does not open an editor after its root becomes obsolete', async t => {
  for (const outcome of ['resolve', 'reject']) await t.test(outcome, async t => {
    const h = harness(t);
    await h.open(rootA);
    const pending = deferred();
    h.behavior.locate = () => pending.promise;
    const older = h.receive({ type: 'openSource', path: 'docs/old.md' });
    await h.open(rootB);
    const published = h.messages.length;
    if (outcome === 'resolve') pending.resolve(path.join(rootA, 'docs/old.md')); else pending.reject(new Error('Old source unavailable'));
    await older;
    assert.deepEqual(h.opened, []);
    assert.deepEqual(h.shown, []);
    assert.equal(h.messages.length, published);
    assert.deepEqual(h.errors, []);
  });
});

test('openSource does not show a document when the root changes during the editor read', async t => {
  for (const outcome of ['resolve', 'reject']) await t.test(outcome, async t => {
    const h = harness(t);
    await h.open(rootA);
    const entered = deferred();
    const pending = deferred();
    h.behavior.openTextDocument = value => { entered.resolve(value); return pending.promise; };
    const older = h.receive({ type: 'openSource', path: 'docs/old.md' });
    const originalUri = await entered.promise;
    await h.open(rootB);
    const published = h.messages.length;
    if (outcome === 'resolve') pending.resolve({ uri: originalUri }); else pending.reject(new Error('Old editor read failed'));
    await older;
    assert.deepEqual(h.opened, [path.join(rootA, 'docs/old.md')]);
    assert.deepEqual(h.shown, []);
    assert.equal(h.messages.length, published);
    assert.deepEqual(h.errors, []);
  });
});

test('search responses keep their scope and discard successes and errors from an obsolete root', async t => {
  for (const outcome of ['resolve', 'reject']) await t.test(outcome, async t => {
    const h = harness(t);
    await h.open(rootA);
    const pending = deferred();
    h.behavior.search = root => root === rootA ? pending.promise : Promise.resolve([{ path: 'openspec/changes/archive/new/proposal.md' }]);
    const older = h.receive({ type: 'search', requestId: 1, query: 'older', scope: 'archive' });
    await h.open(rootB);
    await h.receive({ type: 'search', requestId: 2, query: 'newer', scope: 'archive' });
    const latest = h.messages.at(-1);
    assert.equal(latest.type, 'results');
    assert.equal(latest.scope, 'archive');
    assert.deepEqual(latest.warnings, ['warnings for archive']);
    const published = h.messages.length;
    if (outcome === 'resolve') pending.resolve([{ path: 'docs/old.md' }]); else pending.reject(new Error('Old search failed'));
    await older;
    assert.equal(h.messages.length, published);
    assert.deepEqual(h.errors, []);
  });
});

test('read and openSource allow documents beyond a page but reject paths outside the document trees', async t => {
  const h = harness(t);
  await h.open(rootA);
  assert.deepEqual(h.api.getState().snapshot.docs, []);
  await h.api.read('docs/outside-visible-page.md');
  assert.equal(h.api.getState().document.path, 'docs/outside-visible-page.md');
  await h.receive({ type: 'openSource', path: 'openspec/specs/off-page/spec.md' });
  assert.deepEqual(h.shown, [path.join(rootA, 'openspec/specs/off-page/spec.md')]);
  await h.receive({ type: 'openSource', path: 'openspec/config.yaml', line: 3 });
  assert.equal(h.shown.at(-1), path.join(rootA, 'openspec/config.yaml'));
  for (const relative of ['../outside.md', '.local/secret.md', 'node_modules/readme.md', 'other-config.yaml', 'docs/../secret.md']) {
    await assert.rejects(h.api.read(relative));
    const before = h.shown.length;
    await h.receive({ type: 'openSource', path: relative });
    assert.equal(h.shown.length, before);
  }
});

test('graph requests reject stale roots and superseded responses and keep archive opt-in', async t => {
  const h = harness(t); await h.open(rootA);
  const pending = deferred(), calls = [];
  h.behavior.graph = (root, options) => { calls.push({ root, options }); return root === rootA ? pending.promise : Promise.resolve({ schemaVersion: 1, rootPath: root, nodes: [], edges: [], coverage: {}, diagnostics: [] }); };
  const old = h.receive({ type: 'graph', requestId: 1, rootPath: rootA });
  await h.open(rootB);
  await h.receive({ type: 'graph', requestId: 2, rootPath: rootB, includeArchive: true });
  const before = h.messages.length;
  pending.resolve({ schemaVersion: 1, rootPath: rootA, nodes: [{ id: 'stale' }], edges: [] }); await old;
  assert.equal(h.messages.length, before);
  assert.equal(h.api.getState().graph.rootPath, rootB);
  assert.equal(calls[0].options.includeArchive, false);
  assert.equal(calls[1].options.includeArchive, true);
  assert.equal(calls[1].options.includeInferred, false);
  await h.receive({ type: 'graph', requestId: 3, rootPath: rootA });
  assert.equal(calls.length, 2);
  await h.api.refresh(); assert.equal(h.api.getState().graph, null);
});

test('instruction and skill sources use explicit document trees, never selected S0 scripts', async t => {
  const h = harness(t); await h.open(rootA);
  for (const relative of ['CLAUDE.md', '.agents/skills/example/SKILL.md', '.claude/agents/reviewer.md', 'openspec/schemas/spec-driven/templates/proposal.md', 'repositorios.json']) {
    await h.receive({ type: 'openSource', path: relative });
    assert.equal(h.shown.at(-1), path.join(rootA, relative));
  }
  for (const relative of ['scripts/run.js', '.claude/settings.json', '.agents/secret.md', 'docs/.LOCAL/secrets.md']) {
    if (relative.includes('.LOCAL')) continue; // Filesystem containment is covered by model tests.
    const count = h.shown.length; await h.receive({ type: 'openSource', path: relative }); assert.equal(h.shown.length, count);
  }
});

test('page and detail messages validate their scope, identifiers and page before changing navigation', async t => {
  const h = harness(t);
  await h.open(rootA);
  const navigation = plain(h.api.getState().navigation);
  for (const message of [
    { type: 'page', scope: 'all', page: 1 }, { type: 'page', scope: 'specs', page: -1 },
    { type: 'page', scope: 'context', page: 1.5 }, { type: 'page', scope: 'archive', page: '1' },
    { type: 'loadChange', id: '../outside', page: 0 }, { type: 'loadChange', id: 'archive/../outside', page: 0 },
    { type: 'loadChange', id: 'valid-change', page: -1 },
  ]) {
    await h.receive(message);
    assert.equal(h.messages.at(-1).type, 'loadError');
    assert.deepEqual(plain(h.api.getState().navigation), navigation);
  }
});
