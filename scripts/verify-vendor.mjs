import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const gitHash = (type, bytes) => createHash('sha1').update(`${type} ${bytes.length}\0`).update(bytes).digest('hex');

export async function verifyVendor() {
  const record = JSON.parse(await readFile(path.join(root, 'vendor/conocimiento.json'), 'utf8'));
  const directory = path.join(root, record.localDirectory);
  assert.deepEqual((await readdir(directory)).sort(), record.files.map(file => file.path).sort(), 'Vendor file inventory changed');
  const tree = [];
  for (const file of [...record.files].sort((a, b) => a.path.localeCompare(b.path))) {
    const bytes = await readFile(path.join(directory, file.path));
    assert.equal(bytes.length, file.bytes, `${file.path}: byte length changed`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, `${file.path}: SHA256 changed`);
    assert.equal(gitHash('blob', bytes), file.gitBlob, `${file.path}: differs from original Git blob`);
    tree.push(Buffer.from(`100644 ${file.path}\0`), Buffer.from(file.gitBlob, 'hex'));
  }
  assert.equal(gitHash('tree', Buffer.concat(tree)), record.sourceTree, 'Vendor differs from original Git tree');
  return record;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const record = await verifyVendor();
  console.log(`Verified ${record.files.length} byte-identical modules; upstream tree ${record.sourceTree}`);
}
