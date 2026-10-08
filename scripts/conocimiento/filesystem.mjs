import path from 'node:path';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export const LIMITS = Object.freeze({ maxFiles: 2000, maxBytes: 32 * 1024 * 1024, maxDocumentBytes: 1024 * 1024, maxDepth: 12 });
export const SCOPES = Object.freeze(['context', 'specs', 'changes', 'tools', 'archive']);
const excluded = new Set(['.git', '.local', '.obsidian', 'node_modules', '.env', '.ssh', '.aws']);
const toolsRoots = ['.agents/skills', '.agents/agents', '.claude/skills', '.claude/commands', '.claude/agents', 'openspec/schemas'];
export const portable = value => value.replaceAll('\\', '/');
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export function isExcluded(relative) {
  return portable(relative).split('/').some(part => excluded.has(part.replace(/[ .]+$/, '').toLowerCase()) || /^\.env(?:\.|$)/i.test(part));
}
function unsafeSegment(part) { return part !== '.' && (/[ .]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)); }
export function scopeForPath(relative) {
  if (typeof relative !== 'string') return null;
  const file = portable(relative);
  if (isExcluded(file) || file.startsWith('/') || file.includes(':') || file.split('/').some(part => part === '..' || unsafeSegment(part))) return null;
  if (file === 'repositorios.json') return 'inventory';
  if (!/\.md$/i.test(file)) return null;
  if (file.startsWith('openspec/changes/archive/')) return 'archive';
  if (file.startsWith('openspec/changes/')) return 'changes';
  if (file.startsWith('openspec/specs/')) return 'specs';
  if (file.startsWith('docs/') || file === 'README.md') return 'context';
  if (['AGENTS.md', 'CLAUDE.md'].includes(file) || toolsRoots.some(root => file.startsWith(`${root}/`))) return 'tools';
  return null;
}
export function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}
export async function safeResolve(root, relative, { fileOnly = false, maxBytes = Infinity } = {}) {
  if (typeof relative !== 'string' || !relative || relative.includes('\0') || /^[/\\]/.test(relative) || relative.includes(':')) throw new Error('Ruta de documento inválida.');
  const parts = portable(relative).split('/');
  if (parts.some(part => part === '..' || unsafeSegment(part)) || isExcluded(relative)) throw new Error('La ruta debe permanecer dentro de S0 y fuera de directorios privados, sin alias ambiguos.');
  let current = root;
  let entry;
  for (const part of parts.filter(part => part && part !== '.')) {
    current = path.join(current, part);
    entry = await lstat(current);
    if (entry.isSymbolicLink()) throw new Error('No se siguen enlaces simbólicos ni junctions.');
  }
  const resolved = await realpath(current);
  if (!inside(root, resolved)) throw new Error('La ruta queda fuera de S0.');
  if (fileOnly && !entry?.isFile()) throw new Error('La ruta no es un archivo.');
  if (entry?.size > maxBytes) throw new Error('El documento supera el límite de lectura.');
  return { resolved, entry };
}
export async function readSource(root, relative, maxBytes = LIMITS.maxDocumentBytes) {
  const { resolved, entry } = await safeResolve(root, relative, { fileOnly: true, maxBytes });
  const handle = await open(resolved, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maxBytes || opened.dev !== entry.dev || opened.ino !== entry.ino) throw new Error('El archivo cambió durante la lectura.');
    // A second path check also rejects an ancestor changed to a junction after open.
    const checked = await safeResolve(root, relative, { fileOnly: true, maxBytes });
    if (checked.entry.dev !== opened.dev || checked.entry.ino !== opened.ino) throw new Error('El archivo cambió durante la lectura.');
    const buffer = Buffer.alloc(Math.min(maxBytes + 1, opened.size + 1));
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > maxBytes) throw new Error('El documento supera el límite de lectura.');
    const after = await handle.stat();
    if (length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new Error('El archivo cambió durante la lectura.');
    const data = buffer.subarray(0, length);
    // Preserve BOM and line endings because movement manifests hash the exact source.
    const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
    return { source, bytes: length, hash: sha256(data) };
  } finally { await handle.close(); }
}

export function resolveReference(fromPath, href) {
  if (typeof href !== 'string' || href.includes('\0')) return { blocked: true, reason: 'Destino inválido.' };
  if (/^(?:https?:|mailto:)/i.test(href)) return { external: true, href };
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || /^[/\\]/.test(href)) return { blocked: true, reason: 'Sólo se admiten rutas relativas dentro de S0.' };
  const hash = href.indexOf('#');
  const fragment = hash >= 0 ? href.slice(hash) : '';
  const beforeHash = hash >= 0 ? href.slice(0, hash) : href;
  const question = beforeHash.indexOf('?');
  const query = question >= 0 ? beforeHash.slice(question) : '';
  let destination, anchor;
  try {
    destination = decodeURIComponent(question >= 0 ? beforeHash.slice(0, question) : beforeHash);
    anchor = fragment ? decodeURIComponent(fragment.slice(1)) : '';
  } catch { return { blocked: true, reason: 'Codificación inválida en el destino.' }; }
  if (/^[/\\]/.test(destination) || destination.includes(':') || destination.includes('\0')) return { blocked: true, reason: 'Destino absoluto o inválido.' };
  const parts = portable(fromPath).split('/');
  if (destination) {
    parts.pop();
    for (const part of portable(destination).split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') { if (!parts.length) return { blocked: true, reason: 'El enlace sale de S0.' }; parts.pop(); }
      else parts.push(part);
    }
  }
  const target = parts.join('/');
  if (isExcluded(target) || parts.some(unsafeSegment)) return { blocked: true, reason: 'El destino usa un directorio privado o un alias de ruta ambiguo.' };
  return { path: target, anchor, fragment, query };
}

export async function* scopeFiles(root, scope, limits, issue) {
  const roots = scope === 'context' ? ['README.md', 'docs']
    : scope === 'tools' ? ['AGENTS.md', 'CLAUDE.md', ...toolsRoots]
    : scope === 'archive' ? ['openspec/changes/archive']
    : scope === 'changes' ? ['openspec/changes'] : ['openspec/specs'];
  async function* walk(relative, depth) {
    if (isExcluded(relative) || (scope === 'changes' && relative === 'openspec/changes/archive')) return;
    if (depth > limits.maxDepth) { issue(`Profundidad máxima ${limits.maxDepth}: ${relative}.`, relative); return; }
    let info;
    try { info = await safeResolve(root, relative); }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) issue(error.message, relative); return; }
    if (info.entry.isFile()) { if (scopeForPath(relative) === scope) yield { path: relative, size: info.entry.size }; return; }
    if (!info.entry.isDirectory()) return;
    let entries;
    try { entries = await readdir(info.resolved, { withFileTypes: true }); }
    catch (error) { issue(error.message, relative); return; }
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      if (isExcluded(entry.name)) continue;
      const next = `${relative}/${entry.name}`;
      if (scope === 'changes' && next === 'openspec/changes/archive') continue;
      if (entry.isSymbolicLink()) { issue('Enlace simbólico o junction excluido.', next); continue; }
      yield* walk(next, depth + 1);
    }
  }
  for (const relative of roots) yield* walk(relative, 0);
}
