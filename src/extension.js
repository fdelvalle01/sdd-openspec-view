import * as vscode from 'vscode';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { isOpenSpecRoot, locateDocument, readDocument, scanRoot, searchDocuments, searchWarnings } from './model.js';
import { INVALID_ROOT, resolveRootInput } from './root-selection.js';
import { buildKnowledgeIndex } from './knowledge.js';

const MAX_CLIPBOARD = 20_000;
const PAGE_SCOPES = new Set(['changes', 'archive', 'specs', 'context']);
const navigationDefaults = () => ({ pages: { changes: 0, archive: 0, specs: 0, context: 0 }, selectedChange: null, changePage: 0 });
// A paginated catalogue is not a complete allowlist. Keep on-demand reads inside
// the same document trees; model.js revalidates containment and symlinks on disk.
function cataloguePath(value) {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('Ruta de documento inválida.');
  const file = value.replaceAll('\\', '/');
  if (file.split('/').some(part => !part || part === '.' || part === '..') || !/^(?:(?:README|AGENTS|CLAUDE)\.md|docs\/.+\.md|openspec\/(?:changes|specs|schemas)\/.+\.md|\.(?:agents|claude)\/(?:skills|commands|agents)\/.+\.md|repositorios\.json|openspec\/config\.ya?ml)$/i.test(file)) {
    throw new Error('El documento debe pertenecer al contexto, specs o cambios de S0.');
  }
  return file;
}
const emptySnapshot = () => ({ rootName: 'Visor local', rootPath: '', readAt: null, changes: [], specs: [], docs: [], repositories: [], intents: null, warnings: [] });

export function activate(context) {
  let panel;
  let root;
  let snapshot = emptySnapshot();
  let document = null;
  let watchers = [];
  let timer;
  let version = 0;
  let readVersion = 0;
  let refreshVersion = 0;
  let searchVersion = 0;
  let graphVersion = 0;
  let graphIndex = null;
  let rootIsDemo = false;
  let rootSelectionVersion = 0;
  let rootPersistence = Promise.resolve();
  let navigation = navigationDefaults();
  let disposed = false;
  let webviewReady = false;
  const demoRoot = vscode.Uri.joinPath(context.extensionUri, 'demo').fsPath;
  const send = message => panel?.webview.postMessage(message);
  const readingSettings = () => {
    const configuration = vscode.workspace.getConfiguration('sddWorkspaceViewer');
    const size = configuration.get('readingSize', 15);
    const surfaces = configuration.get('surfaces', 'editor');
    return { readingSize: [14, 15, 16].includes(size) ? size : 15, surfaces: surfaces === 'personal' ? 'personal' : 'editor' };
  };
  const report = error => {
    const message = error instanceof Error ? error.message : String(error);
    if (panel && error?.code === INVALID_ROOT) send({ type: 'invalidRoot', message, path: error.path, codeRepository: Boolean(error.codeRepository) });
    else if (panel) send({ type: 'error', message });
    else vscode.window.showErrorMessage(`OpenSpec: ${message}`);
  };
  const stopWatching = () => {
    clearTimeout(timer);
    watchers.forEach(watcher => watcher.dispose());
    watchers = [];
  };

  async function refresh({ invalidateKnowledge = true } = {}) {
    if (!root || disposed) return;
    const selectedRoot = root;
    const currentVersion = version;
    const request = ++refreshVersion;
    const options = { ...navigation, pages: { ...navigation.pages } };
    ++searchVersion;
    if (invalidateKnowledge) {
      ++graphVersion;
      graphIndex = null;
      await send({ type: 'graphInvalidated', rootPath: selectedRoot });
    }
    let result;
    try { result = await scanRoot(selectedRoot, options); }
    catch (error) {
      if (disposed || currentVersion !== version || request !== refreshVersion) return;
      if (snapshot.loading) snapshot = emptySnapshot();
      throw error;
    }
    if (disposed || currentVersion !== version || request !== refreshVersion) return;
    snapshot = { ...result, demo: rootIsDemo };
    ++searchVersion;
    const selectedPath = document?.path;
    if (selectedPath) {
      const selection = readVersion;
      let updated = null;
      try { updated = await readDocument(selectedRoot, cataloguePath(selectedPath)); }
      catch (error) { result.warnings.push(error.message); }
      if (currentVersion !== version || request !== refreshVersion || disposed) return;
      if (selection === readVersion && document?.path === selectedPath) document = updated;
    }
    await send({ type: 'snapshot', snapshot, document });
  }

  function watch() {
    stopWatching();
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => refresh().catch(report), 220);
    };
    for (const pattern of ['openspec/**', 'docs/**', 'README.md', 'AGENTS.md', 'CLAUDE.md', 'repositorios.json', '.agents/skills/**', '.agents/agents/**', '.agents/commands/**', '.claude/skills/**', '.claude/commands/**', '.claude/agents/**']) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(root), pattern));
      watchers.push(watcher, watcher.onDidCreate(schedule), watcher.onDidChange(schedule), watcher.onDidDelete(schedule));
    }
  }

  async function selectRoot(candidate) {
    const selection = ++rootSelectionVersion;
    if (typeof candidate !== 'string' && candidate?.scheme !== 'file') throw new Error('Esta POC necesita una carpeta local.');
    let selected, selectedDemoRoot;
    try {
      selected = await resolveRootInput(typeof candidate === 'string' ? candidate : candidate.fsPath);
      selectedDemoRoot = await resolveRootInput(demoRoot).catch(() => null);
    }
    catch (error) { if (selection !== rootSelectionVersion || disposed) return; throw error; }
    if (selection !== rootSelectionVersion || disposed) return;
    ++version;
    ++readVersion;
    ++searchVersion;
    ++graphVersion;
    graphIndex = null;
    root = selected;
    const selectedIsDemo = selected === selectedDemoRoot;
    rootIsDemo = selectedIsDemo;
    stopWatching();
    navigation = navigationDefaults();
    document = null;
    snapshot = { ...emptySnapshot(), rootPath: selected, loading: true };
    await send({ type: 'snapshot', snapshot, document });
    rootPersistence = rootPersistence.catch(() => {}).then(async () => {
      if (selection === rootSelectionVersion && !disposed) await context.workspaceState.update('sddWorkspaceViewer.root', selectedIsDemo ? undefined : selected);
    });
    try { await rootPersistence; }
    catch (error) { if (selection !== rootSelectionVersion || disposed) return; throw error; }
    if (selection !== rootSelectionVersion || disposed) return;
    watch();
    await refresh();
  }

  async function page(scope, number) {
    if (!PAGE_SCOPES.has(scope) || !Number.isSafeInteger(number) || number < 0 || number > 1_000_000) throw new Error('Página de catálogo inválida.');
    if (!root || disposed) return;
    navigation = { ...navigation, pages: { ...navigation.pages, [scope]: number } };
    await refresh({ invalidateKnowledge: false });
  }

  async function loadChange(id, number = 0) {
    if (typeof id !== 'string' || id.length > 1024 || !/^(?:archive\/)?[^/\\]+$/.test(id) || id.split('/').some(part => part === '.' || part === '..') || id === 'archive' || id.includes(':') || id.includes('\0') || !Number.isSafeInteger(number) || number < 0 || number > 1_000_000) throw new Error('Cambio o página inválidos.');
    if (!root || disposed) return;
    navigation = { ...navigation, selectedChange: id, changePage: number };
    await refresh({ invalidateKnowledge: false });
  }

  async function chooseRoot() {
    const uris = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, defaultUri: root ? vscode.Uri.file(root) : undefined, openLabel: 'Abrir S0 en el visor', title: 'Selecciona la carpeta que contiene openspec' });
    if (uris?.length) await selectRoot(uris[0]);
  }

  async function enterRootPath(candidate) {
    if (typeof candidate === 'string') return selectRoot(candidate);
    const value = await vscode.window.showInputBox({
      title: 'Abrir S0 por ruta',
      prompt: 'Pega la ruta completa de la carpeta S0 que contiene openspec y pulsa Enter.',
      placeHolder: process.platform === 'win32' ? 'C:\\proyectos\\mi-sistema-specs' : '/proyectos/mi-sistema-specs',
      value: root && !rootIsDemo ? root : context.workspaceState.get('sddWorkspaceViewer.root', ''),
      ignoreFocusOut: true,
      validateInput: async input => {
        try { await resolveRootInput(input); return undefined; }
        catch (error) { return error.message; }
      },
    });
    if (value !== undefined) await selectRoot(value);
  }

  async function read(relative) {
    if (!root || disposed) return;
    const file = cataloguePath(relative);
    const selectedRoot = root;
    const currentVersion = version;
    const request = ++readVersion;
    let result;
    try { result = await readDocument(selectedRoot, file); }
    catch (error) { if (currentVersion !== version || request !== readVersion || disposed) return; throw error; }
    if (currentVersion !== version || request !== readVersion || disposed) return;
    document = result;
    await send({ type: 'document', document });
    return result;
  }

  async function search(query, scope = 'all') {
    if (typeof query !== 'string' || query.length > 200) throw new Error('La búsqueda admite hasta 200 caracteres.');
    if (!['all', 'changes', 'specs', 'context', 'archive'].includes(scope)) throw new Error('Ámbito de búsqueda no reconocido.');
    if (!root || snapshot.loading) return [];
    return searchDocuments(root, snapshot, query, scope);
  }

  async function graph(options = {}, requestId = 0) {
    if (!root || snapshot.loading || disposed) return null;
    const selectedRoot = root, currentVersion = version, request = ++graphVersion;
    const includeArchive = options.includeArchive === true, includeInferred = options.includeInferred === true;
    try {
      const result = await buildKnowledgeIndex(selectedRoot, { includeArchive, includeInferred });
      if (currentVersion !== version || request !== graphVersion || disposed) return null;
      graphIndex = result;
      await send({ type: 'graph', rootPath: selectedRoot, requestId, includeArchive, includeInferred, index: result });
      return result;
    } catch (error) {
      if (currentVersion !== version || request !== graphVersion || disposed) return null;
      await send({ type: 'graph', rootPath: selectedRoot, requestId, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  async function openLink(href) {
    if (typeof href !== 'string' || href.length > 8192) return;
    if (/^https?:\/\//i.test(href)) {
      await vscode.env.openExternal(vscode.Uri.parse(href, true));
      return;
    }
    if (href.startsWith('#')) return;
    if (!document || !root || /^[/\\]/.test(href) || /^[a-z][a-z0-9+.-]*:/i.test(href)) throw new Error('Esta POC abre enlaces Markdown dentro de S0 o enlaces web.');
    const file = decodeURIComponent(href.split(/[?#]/, 1)[0]);
    const relative = path.posix.normalize(path.posix.join(path.posix.dirname(document.path), file.replaceAll('\\', '/')));
    await read(relative);
  }

  function ensurePanel() {
    if (panel) { panel.reveal(vscode.ViewColumn.Active); return; }
    panel = vscode.window.createWebviewPanel('sddWorkspaceViewer', 'OpenSpec Viewer · Personal', vscode.ViewColumn.Active, {
      enableScripts: true,
      enableFindWidget: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    });
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg');
    const webview = panel.webview;
    const nonce = randomBytes(24).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'view.js'));
    const tokens = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'theme-tokens.css'));
    const readingTokens = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'reading-tokens.css'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'view.css'));
    const csp = `default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};`;
    webview.html = `<!doctype html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>OpenSpec Viewer · Personal</title><link rel="stylesheet" href="${tokens}"><link rel="stylesheet" href="${readingTokens}"><link rel="stylesheet" href="${style}"></head><body><div id="app"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
    const listener = webview.onDidReceiveMessage(async message => {
      if (!message || typeof message !== 'object') return;
      // Messages from a replaced S0 may still be queued in the webview bridge.
      if (typeof message.rootPath === 'string' && message.rootPath !== root) return;
      const messageVersion = version;
      try {
        switch (message.type) {
          case 'ready':
            webviewReady = true;
            await send({ type: 'settings', ...readingSettings() });
            await send({ type: 'snapshot', snapshot, document });
            break;
          case 'search': {
            const requestId = message.requestId;
            if (!Number.isSafeInteger(requestId) || requestId < 0) break;
            const request = ++searchVersion;
            const currentVersion = version;
            const query = typeof message.query === 'string' ? message.query : '';
            const scope = message.scope ?? 'all';
            try {
              const results = await search(query, scope);
              if (request === searchVersion && currentVersion === version && !disposed) {
                await send({ type: 'results', requestId, query, scope, results, warnings: searchWarnings(snapshot, scope) });
              }
            } catch (error) {
              if (request === searchVersion && currentVersion === version && !disposed) {
                await send({ type: 'results', requestId, query, scope, results: [], error: error instanceof Error ? error.message : String(error) });
              }
            }
            break;
          }
          case 'graph':
            if (Number.isSafeInteger(message.requestId) && message.requestId >= 0) await graph(message, message.requestId);
            break;
          case 'read':
            // Read failures carry their path so the panel can show them in place of the document.
            try { await read(message.path); }
            catch (error) { await send({ type: 'error', message: error instanceof Error ? error.message : String(error), path: typeof message.path === 'string' ? message.path : undefined }); }
            break;
          case 'page':
          case 'loadChange': {
            const before = refreshVersion;
            try {
              if (message.type === 'page') await page(message.scope, message.page);
              else await loadChange(message.id, message.page ?? 0);
            } catch (error) {
              if (messageVersion === version && refreshVersion <= before + 1 && !disposed) await send({ type: 'loadError', scope: message.scope, id: message.id, message: error instanceof Error ? error.message : String(error) });
            }
            break;
          }
          case 'chooseRoot': await chooseRoot(); break;
          case 'enterRootPath': await enterRootPath(); break;
          case 'refresh': if (root) await refresh(); else await send({ type: 'snapshot', snapshot, document }); break;
          case 'demo': await selectRoot(demoRoot); break;
          case 'link': await openLink(message.href); break;
          case 'openSource': {
            const target = typeof message.path === 'string' ? message.path : document?.path;
            if (!root || !target) return;
            const selectedRoot = root;
            // Revalidate on disk before handing the path to VS Code.
            const file = await locateDocument(selectedRoot, cataloguePath(target));
            if (messageVersion !== version || disposed) return;
            const original = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
            if (messageVersion !== version || disposed) return;
            const line = Number.isSafeInteger(message.line) && message.line > 0 ? Math.min(message.line - 1, Math.max(0, (original.lineCount || message.line) - 1)) : null;
            await vscode.window.showTextDocument(original, { viewColumn: vscode.ViewColumn.Beside, preview: true,
              ...(line !== null ? { selection: new vscode.Range(line, 0, line, 0) } : {}) });
            break;
          }
          case 'copyText':
            if (typeof message.text !== 'string' || message.text.length > MAX_CLIPBOARD) {
              await send({ type: 'copyResult', ok: false, message: 'El texto no se pudo copiar.' });
              break;
            }
            try {
              await vscode.env.clipboard.writeText(message.text);
              await send({ type: 'copyResult', ok: true, message: 'Texto copiado. El visor no ejecutó ningún comando.' });
            } catch {
              await send({ type: 'copyResult', ok: false, message: 'No se pudo acceder al portapapeles.' });
            }
            break;
        }
      } catch (error) { if (messageVersion === version && !disposed) report(error); }
    });
    panel.onDidDispose(() => {
      listener.dispose();
      panel = undefined;
      webviewReady = false;
      stopWatching();
      ++version;
      ++rootSelectionVersion;
      ++searchVersion;
      ++graphVersion;
    }, undefined, context.subscriptions);
  }

  async function open(candidate) {
    ensurePanel();
    if (candidate) return selectRoot(candidate);
    if (root && await isOpenSpecRoot(root)) { watch(); return refresh(); }
    const previous = context.workspaceState.get('sddWorkspaceViewer.root');
    if (previous && await isOpenSpecRoot(previous)) return selectRoot(previous);
    const folders = [];
    for (const folder of vscode.workspace.workspaceFolders || []) {
      if (folder.uri.scheme === 'file' && await isOpenSpecRoot(folder.uri.fsPath)) folders.push(folder);
    }
    if (folders.length === 1) return selectRoot(folders[0].uri);
    if (folders.length > 1) {
      const chosen = await vscode.window.showQuickPick(folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, folder })), { placeHolder: '¿Qué S0 quieres leer?' });
      if (chosen) return selectRoot(chosen.folder.uri);
    }
    await send({ type: 'snapshot', snapshot, document });
  }

  const command = (id, handler) => context.subscriptions.push(vscode.commands.registerCommand(id, async (...args) => {
    try { return await handler(...args); } catch (error) { report(error); }
  }));
  command('sddWorkspaceViewer.open', open);
  command('sddWorkspaceViewer.demo', async () => { ensurePanel(); await selectRoot(demoRoot); });
  command('sddWorkspaceViewer.selectRoot', async () => { ensurePanel(); await chooseRoot(); });
  command('sddWorkspaceViewer.openPath', async candidate => { ensurePanel(); await enterRootPath(candidate); });
  command('sddWorkspaceViewer.refresh', async () => { if (!panel) await open(); else await refresh(); });
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('sddWorkspaceViewer')) send({ type: 'settings', ...readingSettings(), configurationChanged: true });
  }));
  context.subscriptions.push({ dispose() { disposed = true; ++version; stopWatching(); panel?.dispose(); } });
  // Read-only diagnostics used by the isolated extension-host smoke test.
  return { getState: () => ({ snapshot, document, graph: graphIndex, navigation: { ...navigation, pages: { ...navigation.pages } }, webviewReady, settings: readingSettings(), panelOptions: panel?.options }), refresh, search, graph, page, loadChange, read };
}

export function deactivate() {}
