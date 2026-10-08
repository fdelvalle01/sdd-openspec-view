import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyVendor } from '../scripts/verify-vendor.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

test('the vendored knowledge engine matches its original Git blobs, tree and SHA256 hashes', async () => {
  const record = await verifyVendor();
  assert.equal(record.files.length, 5);
  assert.equal(record.sourceCommit, '37b0f7876bcb25f9308cbb3cd82b54c0ea052474');
});

test('host and Markdown bundles resolve every input inside this repository', async () => {
  const result = await build({
    absWorkingDir: root, entryPoints: ['src/extension.js'], bundle: true,
    platform: 'node', target: 'node22', format: 'cjs', external: ['vscode'],
    write: false, metafile: true, logLevel: 'silent',
  });
  const inputs = Object.keys(result.metafile.inputs);
  for (const file of inputs) {
    const relative = path.relative(root, path.resolve(root, file));
    assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative), `External input: ${file}`);
  }
  assert.ok(inputs.includes('scripts/conocimiento/index.mjs'));
  assert.ok(inputs.includes('scripts/conocimiento/markdown.mjs'));
});

test('the repository is a viewer distribution and only the demo has an OpenSpec root', async () => {
  await assert.rejects(access(path.join(root, 'openspec')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(root, 'repositorios.json')), { code: 'ENOENT' });
  await access(path.join(root, 'demo/openspec/config.yaml'));
});
