const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitFor(predicate, label, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

exports.run = async function run() {
  const fixture = process.env.OPENSPEC_HOST_FIXTURE;
  const resultPath = process.env.OPENSPEC_HOST_RESULT;
  assert.ok(fixture && resultPath, 'Run this suite through scripts/test-host.mjs.');
  const report = { passed: false, vscodeVersion: vscode.version, startedAt: new Date().toISOString(), checks: [] };
  let api;
  async function check(name, action) {
    try {
      await action();
      report.checks.push({ name, passed: true });
    } catch (error) {
      report.checks.push({ name, passed: false, error: error.message });
      throw error;
    }
  }
  function fixturePath(relative) {
    const target = path.resolve(fixture, relative);
    const local = path.relative(path.resolve(fixture), target);
    assert.ok(local && local !== '..' && !local.startsWith('..' + path.sep) && !path.isAbsolute(local), 'Mutations must remain in the copied fixture.');
    return target;
  }
  try {
    await check('extension activates in the installed VS Code host', async () => {
      const extension = vscode.extensions.getExtension('fdelvalle01.openspec-viewer');
      assert.ok(extension, 'The development extension is registered.');
      api = await extension.activate();
      assert.equal(extension.isActive, true);
      assert.equal(typeof api.getState, 'function');
      for (const method of ['page', 'loadChange', 'read']) assert.equal(typeof api[method], 'function', method);
    });
    await check('demo command loads active changes, archive, and canonical specs', async () => {
      await vscode.commands.executeCommand('sddWorkspaceViewer.demo');
      const { snapshot } = api.getState();
      assert.equal(snapshot.demo, true);
      assert.ok(snapshot.changes.some(change => !change.archived));
      assert.ok(snapshot.changes.some(change => change.archived));
      assert.ok(snapshot.specs.length > 0);
      assert.ok(snapshot.docs.length > 0);
      assert.match(snapshot.description, /SIMULACIÓN/);
      assert.equal(snapshot.template.config, true);
      assert.equal(snapshot.template.indice, true);
      assert.equal(snapshot.changes.find(change => change.archived).archivedAt, '2026-09-15');
      const archived = snapshot.changes.find(change => change.archived);
      assert.equal(archived.loadState, 'unloaded');
      assert.deepEqual(archived.documents, []);
      assert.equal(archived.tasks, null);
      assert.ok(archived.artifacts.every(artifact => artifact.present === null));
    });
    await check('native find and reading settings are enabled in the real host', async () => {
      assert.equal(api.getState().panelOptions.enableFindWidget, true);
      assert.deepEqual(api.getState().settings, { readingSize: 15, surfaces: 'editor' });
      const configuration = vscode.workspace.getConfiguration('sddWorkspaceViewer');
      await configuration.update('readingSize', 16, vscode.ConfigurationTarget.Workspace);
      await configuration.update('surfaces', 'personal', vscode.ConfigurationTarget.Workspace);
      await waitFor(() => api.getState().settings.readingSize === 16 && api.getState().settings.surfaces === 'personal', 'workspace-scoped reading settings');
      await configuration.update('readingSize', 15, vscode.ConfigurationTarget.Workspace);
      await configuration.update('surfaces', 'editor', vscode.ConfigurationTarget.Workspace);
      await waitFor(() => api.getState().settings.readingSize === 15 && api.getState().settings.surfaces === 'editor', 'restored fixture reading settings');
    });
    await check('host search reads document contents without including archived changes', async () => {
      assert.equal(typeof api.search, 'function');
      const results = await api.search('mayúsculas', 'all');
      assert.ok(results.some(result => result.path === 'openspec/changes/catalog-search/specs/catalog/spec.md'));
      assert.ok(results.every(result => !result.path.startsWith('openspec/changes/archive/')));
      assert.ok(results.every(result => typeof result.snippet === 'string' && result.count > 0));
      const specs = await api.search('recursos', 'specs');
      assert.ok(specs.length > 0);
      assert.ok(specs.every(result => result.path.startsWith('openspec/specs/')));
    });
    await check('the real host builds the bundled knowledge engine with archive opt-in', async () => {
      const graph = await api.graph();
      assert.equal(graph.schemaVersion, 1);
      assert.equal(graph.coverage.archive.status, 'excluded');
      assert.ok(graph.nodes.some(node => node.kind === 'change'));
      assert.ok(graph.edges.some(edge => edge.origin === 'structural'));
      assert.ok(graph.nodes.some(node => node.path === 'docs/INDICE.md'));
      assert.ok(graph.edges.filter(edge => edge.inferred).every(edge => edge.origin === 'inferred' && edge.evidence.length > 0));
      const archived = await api.graph({ includeArchive: true });
      assert.notEqual(archived.coverage.archive.status, 'excluded');
      assert.ok(archived.nodes.some(node => node.scope === 'archive'));
      await api.refresh();
      assert.equal(api.getState().graph, null);
    });
    await check('real webview JavaScript connects through the message bridge and starts at the S0 home', async () => {
      // Only the bundled webview can announce itself; the home view must not request any document.
      await waitFor(() => api.getState().webviewReady, 'the real webview to announce itself through the bridge');
      await sleep(1_500);
      assert.equal(api.getState().document, null, 'The first view is the S0 home, without opening a document automatically.');
      const change = api.getState().snapshot.changes.find(item => item.id === 'catalog-search');
      assert.ok(change, 'The demo contains catalog-search.');
      assert.equal(change.next.title, 'Continuar tareas pendientes');
      assert.deepEqual(change.summary.sections.map(section => section.label), ['Por qué', 'Qué cambia', 'Capacidades', 'Impacto']);
      assert.ok(api.getState().snapshot.intents.length > 0, 'The demo index of intentions is read.');
    });
    await check('open command selects an S0 outside the VS Code workspace', async () => {
      const editorFolders = vscode.workspace.workspaceFolders || [];
      assert.equal(editorFolders.length, 1);
      assert.notEqual(await fs.realpath(editorFolders[0].uri.fsPath), await fs.realpath(fixture));
      await vscode.commands.executeCommand('sddWorkspaceViewer.open', fixture);
      assert.equal(await fs.realpath(api.getState().snapshot.rootPath), await fs.realpath(fixture));
      assert.equal(api.getState().snapshot.demo, false);
      // Give the native file watcher time to register before the first mutation.
      await sleep(1_000);
    });
    await check('saving tasks through VS Code updates task counts through the watcher', async () => {
      const change = api.getState().snapshot.changes.find(item => !item.archived && item.documents.some(document => document.kind === 'tasks'));
      assert.ok(change, 'The demo fixture contains an active tasks document.');
      const tasks = change.documents.find(document => document.kind === 'tasks');
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(fixturePath(tasks.path)));
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), '# Host smoke tasks\n\n- [x] Completed in the isolated fixture\n- [ ] Pending in the isolated fixture\n');
      assert.equal(await vscode.workspace.applyEdit(edit), true);
      assert.equal(await document.save(), true);
      await waitFor(() => {
        const current = api.getState().snapshot.changes.find(item => item.id === change.id);
        return current?.tasks.total === 2 && current.tasks.done === 1;
      }, 'saved task counts without invoking refresh');
    });
    await check('the search index reflects the watcher snapshot after a document is saved', async () => {
      const results = await api.search('Pending in the isolated fixture', 'changes');
      assert.equal(results.length, 1);
      assert.equal(results[0].path, 'openspec/changes/catalog-search/tasks.md');
      assert.match(results[0].snippet, /Pending in the isolated fixture/);
    });
    const addedChange = fixturePath('openspec/changes/host-smoke-created');
    await check('creating a change updates the index through the watcher', async () => {
      await fs.mkdir(addedChange);
      await fs.writeFile(path.join(addedChange, 'proposal.md'), '# Host smoke created change\n');
      await fs.writeFile(path.join(addedChange, 'tasks.md'), '- [ ] Created by host smoke\n');
      await waitFor(() => {
        const change = api.getState().snapshot.changes.find(item => item.id === 'host-smoke-created');
        return change?.tasks.total === 1 && change.documents.some(document => document.kind === 'proposal');
      }, 'a new change without invoking refresh');
    });
    await check('deleting a change updates the index through the watcher', async () => {
      assert.equal(addedChange, fixturePath('openspec/changes/host-smoke-created'));
      await fs.rm(addedChange, { recursive: true });
      await waitFor(() => !api.getState().snapshot.changes.some(item => item.id === 'host-smoke-created'), 'deleted change removal without invoking refresh');
    });
    await check('the direct path command accepts a copied path with quotes', async () => {
      await vscode.commands.executeCommand('sddWorkspaceViewer.demo');
      await vscode.commands.executeCommand('sddWorkspaceViewer.openPath', `  "${fixture}"  `);
      assert.equal(await fs.realpath(api.getState().snapshot.rootPath), await fs.realpath(fixture));
      assert.equal(api.getState().snapshot.demo, false);
    });
    await check('category pages are independent and archived changes stay unloaded', async () => {
      // Populate only the isolated fixture while the extension watches the immutable demo.
      await vscode.commands.executeCommand('sddWorkspaceViewer.demo');
      for (let index = 0; index < 105; index += 1) {
        const suffix = String(index).padStart(3, '0');
        const spec = fixturePath(`openspec/specs/host-page-${suffix}/spec.md`);
        await fs.mkdir(path.dirname(spec), { recursive: true });
        await fs.writeFile(spec, `# Host specification ${suffix}\n\n${index === 104 ? 'HostOnlyBeyondPageMarker' : 'Fixture specification'}\n`);
        await fs.writeFile(fixturePath(`docs/host-page-${suffix}.md`), `# Host context ${suffix}\n`);
      }
      for (let index = 0; index < 52; index += 1) {
        const folder = fixturePath(`openspec/changes/archive/2026-10-08-host-lazy-${String(index).padStart(3, '0')}`);
        await fs.mkdir(folder, { recursive: true });
        await fs.writeFile(path.join(folder, 'proposal.md'), '# Host archived proposal\n\nHostArchiveSearchMarker\n');
        await fs.writeFile(path.join(folder, 'tasks.md'), '- [x] Synthetic archived task\n');
      }
      await vscode.commands.executeCommand('sddWorkspaceViewer.open', fixture);
      // File watcher refreshes may supersede the initial scan after fixture creation.
      // Wait for its observable result, not merely the command promise.
      const canonicalFixture = await fs.realpath(fixture);
      if (!api.getState().snapshot.pagination) {
        const initial = api.getState().snapshot;
        report.catalogueInitialState = { rootPath: initial.rootPath, loading: Boolean(initial.loading), pagination: Boolean(initial.pagination) };
      }
      await waitFor(() => {
        const current = api.getState().snapshot;
        return current.rootPath === canonicalFixture && !current.loading && current.pagination;
      }, 'the paginated fixture snapshot after concurrent watcher refreshes', 30_000);
      let state = api.getState();
      assert.equal(state.snapshot.pagination.specs.page, 0);
      assert.equal(state.snapshot.pagination.specs.hasMore, true);
      assert.equal(state.snapshot.pagination.context.hasMore, true);
      assert.equal(state.snapshot.pagination.archive.hasMore, true);
      assert.ok(state.snapshot.changes.filter(change => change.archived).every(change => change.loadState === 'unloaded'));
      const contextBefore = state.snapshot.docs.map(item => item.path);
      await api.page('specs', 1);
      state = api.getState();
      assert.equal(state.snapshot.pagination.specs.page, 1);
      assert.equal(state.snapshot.pagination.context.page, 0);
      assert.deepEqual(state.snapshot.docs.map(item => item.path), contextBefore);
      const specsBefore = state.snapshot.specs.map(item => item.path);
      await api.page('context', 1);
      state = api.getState();
      assert.equal(state.snapshot.pagination.context.page, 1);
      assert.deepEqual(state.snapshot.specs.map(item => item.path), specsBefore);
      await api.page('archive', 1);
      assert.equal(api.getState().snapshot.pagination.archive.page, 1);
      assert.ok(api.getState().snapshot.changes.some(change => change.archived && change.loadState === 'unloaded'));
    });
    await check('archive search is opt-in and selecting a change outside its page hydrates only its detail', async () => {
      await api.page('archive', 0);
      const listed = new Set(api.getState().snapshot.pagination.archive.ids);
      const outsideId = Array.from({ length: 52 }, (_, index) => `archive/2026-10-08-host-lazy-${String(index).padStart(3, '0')}`)
        .find(id => !listed.has(id));
      assert.ok(outsideId, 'An archive change is outside the current page.');
      assert.deepEqual(await api.search('HostArchiveSearchMarker', 'all'), []);
      const archivedResults = await api.search('HostArchiveSearchMarker', 'archive');
      assert.ok(archivedResults.length > 0);
      assert.ok(archivedResults.every(result => result.path.startsWith('openspec/changes/archive/')));
      assert.ok(api.getState().snapshot.changes.filter(change => change.archived).every(change => change.loadState === 'unloaded'), 'Searching must not replace lazy detail with fake empty task counts.');
      await api.loadChange(outsideId);
      const state = api.getState();
      const selected = state.snapshot.changes.find(change => change.id === outsideId);
      assert.ok(selected);
      assert.ok(!state.snapshot.pagination.archive.ids.includes(outsideId), 'The selected detail must not enter the current archive page.');
      assert.equal(selected.loadState, 'loaded');
      assert.equal(selected.tasks.total, 1);
      assert.equal(selected.tasks.done, 1);
      assert.ok(selected.documents.some(document => document.kind === 'proposal'));
      assert.equal(state.snapshot.pagination.archive.page, 0);
      assert.ok(state.snapshot.changes.filter(change => change.archived && change.id !== outsideId).every(change => change.loadState === 'unloaded'));
    });
    await check('search results outside the visible page open and survive refresh without changing category pages', async () => {
      await api.page('specs', 0);
      const target = 'openspec/specs/host-page-104/spec.md';
      assert.ok(!api.getState().snapshot.specs.some(item => item.path === target));
      const results = await api.search('HostOnlyBeyondPageMarker', 'specs');
      assert.ok(results.some(result => result.path === target));
      await api.read(target);
      assert.equal(api.getState().document.path, target);
      assert.match(api.getState().document.html, /HostOnlyBeyondPageMarker/);
      const pages = Object.fromEntries(Object.entries(api.getState().snapshot.pagination).map(([scope, value]) => [scope, value.page]));
      const selected = api.getState().navigation.selectedChange;
      await api.refresh();
      assert.equal(api.getState().document.path, target);
      assert.deepEqual(Object.fromEntries(Object.entries(api.getState().snapshot.pagination).map(([scope, value]) => [scope, value.page])), pages);
      assert.equal(api.getState().navigation.selectedChange, selected);
      await assert.rejects(api.read('.local/secret.md'));
      await assert.rejects(api.read('../outside.md'));
      assert.equal(api.getState().document.path, target, 'Rejected paths preserve the selected document.');
    });
    await check('switching roots resets page and detail navigation without carrying the old document', async () => {
      await vscode.commands.executeCommand('sddWorkspaceViewer.demo');
      const state = api.getState();
      assert.equal(state.snapshot.demo, true);
      assert.equal(state.document, null);
      assert.equal(state.navigation.selectedChange, null);
      assert.ok(Object.values(state.snapshot.pagination).every(page => page.page === 0));
      assert.ok(state.snapshot.changes.filter(change => change.archived).every(change => change.loadState === 'unloaded'));
    });
    if (process.env.OPENSPEC_HOST_READONLY_ROOT) {
      await check('the direct path command reads the provided real S0 without changing it', async () => {
        const realS0 = process.env.OPENSPEC_HOST_READONLY_ROOT;
        await vscode.commands.executeCommand('sddWorkspaceViewer.openPath', realS0);
        assert.equal(await fs.realpath(api.getState().snapshot.rootPath), await fs.realpath(realS0));
        assert.equal(api.getState().snapshot.demo, false);
        assert.deepEqual(api.getState().snapshot.warnings, []);
      });
    }
    report.passed = true;
  } catch (error) {
    report.error = error.stack || String(error);
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(resultPath, JSON.stringify(report, null, 2));
  }
};
