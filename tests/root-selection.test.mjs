import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { INVALID_ROOT, looksLikeCodeRepository, resolveRootInput } from '../src/root-selection.js';
import { scanRoot } from '../src/model.js';

test('pasted worktree paths accept quotes, spaces and the openspec folder', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'openspec-path-'));
  try {
    const s0 = path.join(temporary, '.worktrees', 'my system');
    await mkdir(path.join(s0, 'openspec'), { recursive: true });
    await writeFile(path.join(s0, 'openspec/config.yaml'), 'schema: spec-driven\n');
    await writeFile(path.join(s0, '.git'), 'gitdir: ../main/.git/worktrees/example\n');
    const canonical = await realpath(s0);
    assert.equal(await resolveRootInput(`  "${s0}"  `), canonical);
    assert.equal(await resolveRootInput(`'${s0}'`), canonical);
    assert.equal(await resolveRootInput(path.join(s0, 'openspec')), canonical);
    await assert.rejects(resolveRootInput(path.join(s0, 'openspec/config.yaml')), /carpeta, no un archivo/);
    await assert.rejects(resolveRootInput(temporary), /debe contener openspec/);
    await assert.rejects(resolveRootInput(path.join(temporary, 'missing')), /no existe/);
  } finally {
    const safe = path.resolve(temporary);
    assert.equal(path.dirname(safe), path.resolve(os.tmpdir()));
    assert.ok(path.basename(safe).startsWith('openspec-path-'));
    await rm(safe, { recursive: true, force: true });
  }
});

test('pasted paths reject empty values, relative paths and website URLs', async () => {
  for (const invalid of ['', ' ', '""', '../s0', 'https://github.com/example/s0', undefined]) {
    await assert.rejects(resolveRootInput(invalid), /ruta/);
  }
});

test('Windows URI drive casing resolves to the same root identity used by snapshots', { skip: process.platform !== 'win32' }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'openspec-path-'));
  try {
    const s0 = path.join(temporary, 'S0');
    await mkdir(path.join(s0, 'openspec'), { recursive: true });
    await writeFile(path.join(s0, 'openspec/config.yaml'), 'schema: spec-driven\n');
    const canonical = await realpath(s0);
    // VS Code Uri.fsPath uses a lowercase drive letter on Windows.
    const uriPath = canonical.replace(/^([A-Z]):/, (_, drive) => `${drive.toLowerCase()}:`);
    const selected = await resolveRootInput(uriPath);
    const snapshot = await scanRoot(selected);
    assert.equal(selected, canonical, 'selection must canonicalize the root before it enters the webview protocol');
    assert.equal(snapshot.rootPath, selected, 'graph requests made from the snapshot must pass the host root identity check');
  } finally {
    const safe = path.resolve(temporary);
    assert.equal(path.dirname(safe), path.resolve(os.tmpdir()));
    assert.ok(path.basename(safe).startsWith('openspec-path-'));
    await rm(safe, { recursive: true, force: true });
  }
});

test('a folder without OpenSpec reports its path and whether it looks like a code repository', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'openspec-path-'));
  try {
    const code = path.join(temporary, 'terminal');
    await mkdir(path.join(code, 'src'), { recursive: true });
    await writeFile(path.join(code, 'package.json'), '{}\n');
    const plain = path.join(temporary, 'plain');
    await mkdir(plain);
    await assert.rejects(resolveRootInput(code), error => error.code === INVALID_ROOT && error.path === code && error.codeRepository === true && /debe contener openspec/.test(error.message));
    await assert.rejects(resolveRootInput(plain), error => error.code === INVALID_ROOT && error.codeRepository === false);
    assert.equal(await looksLikeCodeRepository(code), true);
  } finally {
    const safe = path.resolve(temporary);
    assert.equal(path.dirname(safe), path.resolve(os.tmpdir()));
    assert.ok(path.basename(safe).startsWith('openspec-path-'));
    await rm(safe, { recursive: true, force: true });
  }
});
