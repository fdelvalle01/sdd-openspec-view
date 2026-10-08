import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = file => readFile(path.join(root, file), 'utf8');

test('the personal package keeps its extension, command, panel and configuration identity', async () => {
  const pkg = JSON.parse(await read('package.json'));
  const lock = JSON.parse(await read('package-lock.json'));
  assert.equal(`${pkg.publisher}.${pkg.name}`, 'fdelvalle01.openspec-viewer');
  assert.equal(pkg.displayName, 'OpenSpec Viewer · Personal');
  assert.equal(pkg.version, '0.3.2');
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(pkg.repository.url, 'https://github.com/fdelvalle01/sdd-openspec-view.git');
  assert.equal(pkg.repository.directory, undefined);
  const prefix = 'sddWorkspaceViewer';
  for (const command of pkg.contributes.commands) assert.ok(command.command.startsWith(prefix + '.'));
  for (const property of Object.keys(pkg.contributes.configuration.properties)) assert.ok(property.startsWith(prefix + '.'));
  assert.deepEqual(pkg.contributes.configuration.properties[`${prefix}.surfaces`].enum, ['editor', 'personal']);
  const extension = await read('src/extension.js');
  assert.match(extension, /createWebviewPanel\('sddWorkspaceViewer'/);
  assert.match(extension, /workspaceState\.update\('sddWorkspaceViewer\.root'/);
  assert.match(extension, /getConfiguration\('sddWorkspaceViewer'\)/);
  assert.match(extension, /affectsConfiguration\('sddWorkspaceViewer'\)/);
});

test('the personal viewer keeps system fonts and the generic cube icon', async () => {
  const theme = await read('media/theme-tokens.css');
  const reading = await read('media/reading-tokens.css');
  const icon = await read('media/icon.svg');
  const ui = await read('src/webview.js');
  const assets = await readdir(path.join(root, 'media'));
  assert.match(theme, /var\(--vscode-font-family, system-ui\)/);
  assert.match(theme, /var\(--vscode-editor-font-family, ui-monospace\)/);
  assert.doesNotMatch(theme + reading, /@font-face|url\(/);
  assert.ok(!assets.includes('fonts'));
  assert.match(icon, /M64 23 101 44v41L64 106 27 85V44l37-21Z/);
  assert.match(ui, /function viewerMark\(className\) \{\s*return icon\('mark', className\);/);
  assert.match(ui, /surfaceMode: saved\.surfaceMode === 'personal'/);
  const ignore = await read('.vscodeignore');
  assert.match(ignore, /\*\*\/\*\.vsix/);
});
