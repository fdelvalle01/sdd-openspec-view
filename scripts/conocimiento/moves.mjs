import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readSource, resolveReference, safeResolve, scopeForPath } from './filesystem.mjs';

const hash = (source) => createHash('sha256').update(source).digest('hex');
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const within = (name, parent) => {
  if (process.platform === 'win32') { name = name.toLowerCase(); parent = parent.toLowerCase(); }
  return name === parent || name.startsWith(`${parent}/`);
};
const archived = (name) => name.startsWith('openspec/changes/archive/');
const mapPath = (name, from, to) => within(name, from) ? `${to}${name.slice(from.length)}` : name;
const documentPath = (name) => /\.md$/i.test(name) && scopeForPath(name) !== null;

function fail(message, code = 'MOVE_CONFLICT') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function relativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || /[\x00-\x1f:]/.test(value)
    || value.startsWith('/') || value.split('/').some((part) => !part || part === '.' || part === '..')
    || value.split('/').some((part) => /^(?:\.git|node_modules)$/i.test(part))
    || (process.platform === 'win32' && value.split('/').some((part) => /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))) {
    fail(`Ruta relativa no segura: ${String(value)}`, 'UNSAFE_PATH');
  }
  return value;
}

async function ownerRoot(root) {
  return realpath(path.resolve(root));
}

// Existing ancestors are inspected individually: a junction must not turn a
// local plan or a future destination into a write outside its selected S0.
async function checkedDestination(root, relative) {
  relativePath(relative);
  let current = root;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) fail(`No se permiten enlaces simbólicos: ${relative}`, 'UNSAFE_PATH');
      const actual = await realpath(current);
      const rel = path.relative(root, actual);
      if (rel.startsWith(`..${path.sep}`) || rel === '..' || path.isAbsolute(rel)) fail(`Destino fuera de S0: ${relative}`, 'UNSAFE_PATH');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return path.join(root, ...relative.split('/'));
}

function validateMapping(from, to) {
  relativePath(from);
  relativePath(to);
  if (samePath(from, to) || within(to, from) || within(from, to)) fail('Las rutas de origen y destino deben ser distintas y no contenerse.');
  const allowed = (name) => documentPath(name) || ['docs', 'openspec/specs', 'openspec/changes'].some((base) => name.startsWith(`${base}/`));
  if (!allowed(from) || !allowed(to) || /(?:^|\/)\.local(?:\/|$)/i.test(from + '/' + to)) fail('El movimiento debe permanecer en las áreas documentales de S0.', 'UNSAFE_PATH');
}

function assertComplete(index) {
  if (!index || !index.coverage || !Array.isArray(index.nodes)) fail('Falta el índice completo anterior al movimiento.');
  const incomplete = [...new Set([
    ...['context', 'specs', 'changes', 'tools', 'archive'].filter((name) => index.coverage[name]?.status !== 'complete'),
    ...Object.keys(index.coverage).filter((name) => index.coverage[name]?.status === 'partial'),
  ])];
  if (incomplete.length) fail(`No se puede preparar con cobertura incompleta: ${incomplete.join(', ')}.`, 'INCOMPLETE_COVERAGE');
}

function planHash(plan) {
  const { integrity, ...data } = plan;
  return hash(JSON.stringify(data));
}

function originalSuffix(raw) {
  // Keep literal fragments/queries, including Markdown escapes/entities. A
  // percent-encoded # remains part of the filename, never an anchor delimiter.
  const match = /(?:\\?[?#]|&(?:num|quest|#(?:0*35|0*63|[xX]0*23|[xX]0*3[fF]));)/.exec(raw);
  return match ? { pathname: raw.slice(0, match.index), suffix: raw.slice(match.index) } : { pathname: raw, suffix: '' };
}

function encodedRelative(from, to) {
  return path.posix.relative(path.posix.dirname(from), to).split('/').map((segment) => encodeURIComponent(segment).replace(/[()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
}

function expectedEdit(source, sourcePath, afterPath, link, from, to) {
  const reference = resolveReference(sourcePath, link.href);
  if (reference.external || /^[a-z][a-z\d+.-]*:/i.test(link.href) || link.href.startsWith('//') || link.href.startsWith('/')) return null;
  const sourceMoved = sourcePath !== afterPath;
  const targetMoved = reference.path && mapPath(reference.path, from, to) !== reference.path;
  if (!sourceMoved && !targetMoved) return null;
  if (reference.blocked || !reference.path) fail(`Referencia afectada no segura en ${sourcePath}:${link.line}: ${link.href}`);
  const start = link.destinationStart;
  const end = link.destinationEnd;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > source.length) fail(`No se puede localizar inequívocamente el destino en ${sourcePath}:${link.line}.`);
  const before = source.slice(start, end);
  if (before !== link.rawDestination) fail(`El destino y sus posiciones no coinciden en ${sourcePath}:${link.line}.`);
  const { pathname, suffix } = originalSuffix(before);
  const targetAfter = mapPath(reference.path, from, to);
  const relative = !pathname && reference.path === sourcePath ? '' : encodedRelative(afterPath, targetAfter);
  const after = `${relative}${suffix}`;
  if (after === before) return null;
  return { start, end, before, after, line: link.line, href: link.href, target: reference.path, targetAfter, anchor: reference.anchor || null };
}

function editsFor(source, sourcePath, afterPath, parseMarkdown, from, to) {
  const spans = new Map();
  for (const link of parseMarkdown(source).links) {
    const edit = expectedEdit(source, sourcePath, afterPath, link, from, to);
    if (!edit) continue;
    const key = `${edit.start}:${edit.end}`;
    if (spans.has(key) && JSON.stringify(spans.get(key)) !== JSON.stringify(edit)) fail(`Destino ambiguo en ${sourcePath}:${link.line}.`);
    spans.set(key, edit);
  }
  const edits = [...spans.values()].sort((a, b) => a.start - b.start);
  if (edits.some((edit, i) => i > 0 && edit.start < edits[i - 1].end)) fail(`Destinos superpuestos en ${sourcePath}.`);
  return edits;
}

function applyEdits(source, edits) {
  let result = source;
  for (const edit of [...edits].reverse()) result = result.slice(0, edit.start) + edit.after + result.slice(edit.end);
  return result;
}

function verifiedResult(source, sourcePath, afterPath, edits, parseMarkdown) {
  const result = applyEdits(source, edits);
  if (!edits.length) return result;
  const links = new Map(parseMarkdown(result).links.map((link) => [link.destinationStart, link]));
  let delta = 0;
  for (const edit of edits) {
    const updated = links.get(edit.start + delta);
    const before = resolveReference(sourcePath, edit.href);
    const after = updated && resolveReference(afterPath, updated.href);
    if (!after?.path || !samePath(after.path, edit.targetAfter) || after.anchor !== before.anchor || after.query !== before.query) fail(`La reparación alteraría el significado del enlace en ${sourcePath}:${edit.line}.`);
    delta += edit.after.length - (edit.end - edit.start);
  }
  return result;
}

async function validateTarget(root, target, anchor, parseMarkdown) {
  await safeResolve(root, target);
  if (anchor && /\.md$/i.test(target)) {
    const { source } = await readSource(root, target);
    if (!parseMarkdown(source).anchors.includes(anchor)) fail(`No existe el ancla afectada: ${target}#${anchor}.`);
  }
}

/** Build a verifiable plan before the official archive or an explicit rename. */
export async function prepareMove(root, { from, to, index, parseMarkdown }) {
  root = await ownerRoot(root);
  validateMapping(from, to);
  assertComplete(index);
  if (!samePath(path.resolve(index.rootPath), root)) fail('El índice pertenece a otro S0.');
  await safeResolve(root, from);
  const destination = await checkedDestination(root, to);
  try {
    await lstat(destination);
    fail(`El destino ya existe: ${to}.`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const documents = index.nodes.filter((node) => node.kind === 'document' && documentPath(node.path));
  if (!documents.some((node) => within(node.path, from))) fail('El origen no contiene documentos indexados.');
  const files = [];
  const archivedReferences = [];
  for (const node of documents.sort((a, b) => a.path.localeCompare(b.path))) {
    if (node.readState !== 'loaded') fail(`Documento sin lectura completa: ${node.path}.`, 'INCOMPLETE_COVERAGE');
    const { source, hash: actualHash } = await readSource(root, node.path);
    if (actualHash !== node.hash || actualHash !== hash(source)) fail(`El documento cambió durante la preparación o no es UTF-8: ${node.path}.`);
    const afterPath = mapPath(node.path, from, to);
    const edits = editsFor(source, node.path, afterPath, parseMarkdown, from, to);
    if (archived(node.path) && afterPath === node.path) {
      for (const edit of edits) archivedReferences.push({ path: node.path, line: edit.line, href: edit.href, targetAfter: edit.targetAfter });
      continue;
    }
    if (!edits.length && afterPath === node.path) continue;
    for (const edit of edits) await validateTarget(root, edit.target, edit.anchor, parseMarkdown);
    files.push({ path: node.path, afterPath, beforeHash: actualHash, afterHash: hash(verifiedResult(source, node.path, afterPath, edits, parseMarkdown)), edits });
  }
  const plan = { schemaVersion: 1, kind: 's0-document-move', rootPath: root, from, to, createdAt: new Date().toISOString(), coverage: index.coverage, files, archivedReferences };
  return { ...plan, integrity: planHash(plan) };
}

/** Plans are local data, never executable input or a second document store. */
export async function saveMovePlan(root, output, plan) {
  root = await ownerRoot(root);
  relativePath(output);
  if (!output.startsWith('.local/') || !output.endsWith('.json')) fail('Guarda el plan como .local/...json dentro de S0.', 'UNSAFE_PATH');
  const serialized = `${JSON.stringify(plan, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > 32 * 1024 * 1024) fail('El plan supera 32 MiB; no se escribió un manifiesto que no pueda volver a leerse.');
  const target = await checkedDestination(root, output);
  await mkdir(path.dirname(target), { recursive: true });
  await checkedDestination(root, output);
  await writeFile(target, serialized, { encoding: 'utf8', flag: 'wx' });
  return target;
}

export async function readMovePlan(root, input) {
  root = await ownerRoot(root);
  relativePath(input);
  if (!input.startsWith('.local/') || !input.endsWith('.json')) fail('El plan debe ser un .local/...json de este S0.', 'UNSAFE_PATH');
  const target = await checkedDestination(root, input);
  const stat = await lstat(target);
  if (!stat.isFile() || stat.size > 32 * 1024 * 1024) fail('El plan no es un JSON regular de tamaño permitido.');
  const handle = await open(target, 'r');
  try {
    const opened = await handle.stat();
    await checkedDestination(root, input);
    const checked = await lstat(target);
    if (!opened.isFile() || opened.size > 32 * 1024 * 1024 || opened.ino !== stat.ino || opened.dev !== stat.dev || checked.ino !== opened.ino || checked.dev !== opened.dev) fail('El plan cambió durante su lectura.');
    const buffer = Buffer.alloc(Math.min(32 * 1024 * 1024 + 1, opened.size + 1));
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await handle.stat();
    if (length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) fail('El plan cambió durante su lectura.');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)));
  } finally {
    await handle.close();
  }
}

function validatePlan(plan, root) {
  if (plan?.schemaVersion !== 1 || plan.kind !== 's0-document-move' || typeof plan.rootPath !== 'string' || !samePath(path.resolve(plan.rootPath), root)) fail('El plan no corresponde a este S0 o su versión no es compatible.');
  if (planHash(plan) !== plan.integrity) fail('La integridad del plan cambió; no se aplicarán datos manipulados.');
  validateMapping(plan.from, plan.to);
  assertComplete({ ...plan, nodes: [] });
  if (!Array.isArray(plan.files) || !plan.files.length || !Array.isArray(plan.archivedReferences)) fail('El plan no contiene un conjunto válido de documentos.');
  const paths = new Set();
  for (const file of plan.files) {
    relativePath(file.path);
    relativePath(file.afterPath);
    if (!documentPath(file.path) || !documentPath(file.afterPath) || mapPath(file.path, plan.from, plan.to) !== file.afterPath || (archived(file.path) && file.path === file.afterPath)) fail(`Documento no permitido en el plan: ${file.path}.`);
    if (paths.has(file.afterPath) || !/^[a-f\d]{64}$/.test(file.beforeHash) || !/^[a-f\d]{64}$/.test(file.afterHash) || !Array.isArray(file.edits)) fail('Hashes, rutas o destinos duplicados/incorrectos en el plan.');
    paths.add(file.afterPath);
    let end = -1;
    for (const edit of file.edits) {
      if (!Number.isInteger(edit.start) || !Number.isInteger(edit.end) || edit.start < 0 || edit.end < edit.start || edit.start < end || typeof edit.before !== 'string' || typeof edit.after !== 'string') fail('Posiciones de reparación no válidas.');
      end = edit.end;
    }
  }
}

function reconstructOriginal(source, edits) {
  let delta = 0;
  const reverseEdits = edits.map((edit) => {
    const start = edit.start + delta;
    delta += edit.after.length - (edit.end - edit.start);
    if (source.slice(start, start + edit.after.length) !== edit.after) fail('El contenido reparado no coincide con el plan.');
    return { start, end: start + edit.after.length, after: edit.before };
  });
  return applyEdits(source, reverseEdits);
}

function diffFor(file, before, after) {
  if (before === after) return '';
  const oldLines = before.split(/\r?\n/);
  const newLines = after.split(/\r?\n/);
  const lines = [`--- a/${file.afterPath}`, `+++ b/${file.afterPath}`];
  for (let i = 0; i < oldLines.length; i += 1) {
    if (oldLines[i] === newLines[i]) continue;
    lines.push(`@@ -${i + 1},1 +${i + 1},1 @@`, `-${oldLines[i]}`, `+${newLines[i]}`);
  }
  return `${lines.join('\n')}\n`;
}

async function replaceFile(root, relative, source, expectedHash) {
  const { resolved } = await safeResolve(root, relative, { fileOnly: true });
  const stat = await lstat(resolved);
  const temp = path.join(path.dirname(resolved), `.conocimiento-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, source, { encoding: 'utf8', flag: 'wx', mode: stat.mode });
    await safeResolve(root, relative, { fileOnly: true });
    const current = await readSource(root, relative);
    if (current.hash !== expectedHash) fail(`El archivo cambió antes de escribir: ${relative}.`);
    await rename(temp, resolved);
  } finally {
    await unlink(temp).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

/** Preview by default. After a partial write, the same plan resumes safely. */
export async function repairLinks(root, plan, { parseMarkdown, apply = false } = {}) {
  root = await ownerRoot(root);
  validatePlan(plan, root);
  await checkedDestination(root, plan.from);
  const oldPath = path.join(root, ...plan.from.split('/'));
  try {
    await lstat(oldPath);
    fail('El origen todavía existe: ejecuta primero el movimiento oficial.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await safeResolve(root, plan.to);
  const prepared = [];
  // Complete preflight before the first write prevents overwriting an edit in
  // the final file after already changing unrelated earlier files.
  for (const file of plan.files) {
    const { source, hash: currentHash } = await readSource(root, file.afterPath);
    const done = currentHash === file.afterHash && file.afterHash !== file.beforeHash;
    if (currentHash !== file.beforeHash && currentHash !== file.afterHash) fail(`Edición concurrente o archivo inesperado: ${file.afterPath}.`);
    const original = done ? reconstructOriginal(source, file.edits) : source;
    if (hash(original) !== file.beforeHash) fail(`Hash original inconsistente: ${file.path}.`);
    const expected = editsFor(original, file.path, file.afterPath, parseMarkdown, plan.from, plan.to);
    if (JSON.stringify(expected) !== JSON.stringify(file.edits)) fail(`El plan contiene destinos o posiciones manipulados: ${file.path}.`);
    const result = verifiedResult(original, file.path, file.afterPath, expected, parseMarkdown);
    if (hash(result) !== file.afterHash) fail(`Hash posterior inconsistente: ${file.path}.`);
    for (const edit of expected) await validateTarget(root, edit.targetAfter, edit.anchor, parseMarkdown);
    prepared.push({ file, result, currentHash, status: done ? 'already-applied' : expected.length ? 'pending' : 'unchanged', diff: diffFor(file, original, result) });
  }
  const response = { schemaVersion: 1, status: 'preview', applied: [], pending: [], files: prepared.map(({ file, status, diff }) => ({ path: file.afterPath, status, diff })), archivedReferences: plan.archivedReferences };
  if (!apply) {
    response.pending = prepared.filter((item) => item.status === 'pending').map((item) => item.file.afterPath);
    return response;
  }
  for (let i = 0; i < prepared.length; i += 1) {
    const item = prepared[i];
    if (item.status !== 'pending') continue;
    try {
      await replaceFile(root, item.file.afterPath, item.result, item.currentHash);
      response.files[i].status = 'applied';
      response.applied.push(item.file.afterPath);
    } catch (error) {
      response.status = 'partial-failure';
      response.error = { code: error.code || 'WRITE_FAILED', message: error.message };
      response.pending = response.files.filter((file) => file.status === 'pending').map((file) => file.path);
      return response;
    }
  }
  response.status = response.applied.length ? 'applied' : 'already-applied';
  return response;
}
