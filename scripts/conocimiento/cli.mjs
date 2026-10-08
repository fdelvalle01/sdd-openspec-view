#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import { createKnowledgeEngine } from './index.mjs';
import { prepareMove, readMovePlan, repairLinks, saveMovePlan } from './moves.mjs';

export const DEFAULT_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const HELP = `Conocimiento S0 — referencias documentales locales

  conocimiento check [--archive] [--json] [--root RUTA]
  conocimiento query --path DOCUMENTO[#ANCLA] [--depth 1|2] [--offset N] [--limit 1..100] [--archive] [--inferred] [--json]
  conocimiento prepare-move --from RUTA --to RUTA --out .local/plan.json
  conocimiento repair-links --plan .local/plan.json [--apply] [--json]

Todas las órdenes admiten --root RUTA. La raíz predeterminada es el S0 que
contiene este script, aunque se ejecute desde otra carpeta. prepare-move no
mueve archivos. repair-links muestra un diff; sólo --apply escribe destinos.
El archivo previo se examina al preparar movimientos y sus referencias se
informan sin reescribirlas. No se consulta la red ni se ejecuta OpenSpec.
check: salida 0 válida, 1 referencias inválidas, 2 cobertura parcial/error.
`;

function argumentsFor(args) {
  const [command = 'help', ...remaining] = args;
  const options = {};
  const booleans = new Set(['json', 'archive', 'inferred', 'apply', 'help']);
  const values = new Set(['root', 'path', 'depth', 'offset', 'limit', 'from', 'to', 'out', 'plan']);
  for (let i = 0; i < remaining.length; i += 1) {
    const arg = remaining[i];
    if (!arg.startsWith('--') || arg.includes('=')) throw new Error(`Argumento no admitido: ${arg}`);
    const key = arg.slice(2);
    if (Object.hasOwn(options, key)) throw new Error(`Opción repetida: ${arg}`);
    if (booleans.has(key)) options[key] = true;
    else if (values.has(key) && remaining[i + 1] && !remaining[i + 1].startsWith('--')) options[key] = remaining[++i];
    else throw new Error(`Opción desconocida o sin valor: ${arg}`);
  }
  if (options.depth !== undefined && !['1', '2'].includes(options.depth)) throw new Error('--depth debe ser 1 o 2.');
  for (const key of ['offset', 'limit']) {
    if (options[key] === undefined) continue;
    const value = Number(options[key]);
    if (!/^\d+$/.test(options[key]) || !Number.isSafeInteger(value) || value < (key === 'limit' ? 1 : 0) || (key === 'limit' && value > 100)) throw new Error(`--${key} debe ser un entero ${key === 'limit' ? 'entre 1 y 100' : 'mayor o igual a cero'}.`);
  }
  return { command, options };
}

function required(options, key) {
  if (!options[key]) throw new Error(`Falta --${key}.`);
  return options[key];
}

function outputJson(output, result) {
  output.write(`${JSON.stringify(result, null, 2)}\n`);
}

export async function main(args = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  let json = args.includes('--json');
  try {
    const { command, options } = argumentsFor(args);
    json = Boolean(options.json);
    if (['help', '--help', '-h'].includes(command) || options.help) {
      stdout.write(HELP);
      return 0;
    }
    if (!['check', 'query', 'prepare-move', 'repair-links'].includes(command)) throw new Error(`Orden desconocida: ${command}`);
    const root = path.resolve(options.root || DEFAULT_ROOT);
    const engine = createKnowledgeEngine(MarkdownIt);
    if (command === 'repair-links') {
      const plan = await readMovePlan(root, required(options, 'plan'));
      const result = await repairLinks(root, plan, { parseMarkdown: engine.parseMarkdown, apply: Boolean(options.apply) });
      if (json) outputJson(stdout, result);
      else {
        stdout.write(`Reparación: ${result.status}\n`);
        for (const file of result.files) {
          stdout.write(`${file.status}: ${file.path}\n`);
          if (file.diff) stdout.write(file.diff);
        }
        for (const reference of result.archivedReferences) stdout.write(`Historia sin modificar: ${reference.path}:${reference.line} → ${reference.targetAfter}\n`);
        if (result.error) stderr.write(`Cierre documental incompleto: ${result.error.message}\nReintenta con el mismo plan; no se revirtió OpenSpec.\n`);
      }
      return result.status === 'partial-failure' ? 1 : 0;
    }
    const index = await engine.buildIndex(root, { includeArchive: command === 'prepare-move' || Boolean(options.archive), includeInferred: Boolean(options.inferred) });
    if (command === 'prepare-move') {
      const plan = await prepareMove(root, { from: required(options, 'from'), to: required(options, 'to'), index, parseMarkdown: engine.parseMarkdown });
      const output = await saveMovePlan(root, required(options, 'out'), plan);
      if (json) outputJson(stdout, { ...plan, planPath: output });
      else stdout.write(`Plan preparado: ${output}\n${plan.files.length} documentos; ${plan.archivedReferences.length} referencias históricas sólo informadas.\nNo se movieron documentos. Ejecuta el movimiento oficial, revisa repair-links y aplica con --apply.\n`);
      return 0;
    }
    if (command === 'query') {
      const document = required(options, 'path');
      const result = engine.query(index, { path: document, depth: Number(options.depth || 1), offset: Number(options.offset || 0), limit: Number(options.limit || 100), includeInferred: Boolean(options.inferred) });
      outputJson(stdout, result);
      return result.nodes.length ? 0 : 1;
    }
    const partial = Object.values(index.coverage).some((scope) => scope.status === 'partial');
    const invalid = index.diagnostics.some((finding) => finding.severity === 'error');
    const result = { schemaVersion: 1, rootPath: index.rootPath, revision: index.revision, status: partial ? 'partial' : invalid ? 'invalid' : 'valid', summary: { documents: index.nodes.filter((node) => node.kind === 'document').length, nodes: index.nodes.length, edges: index.edges.length }, coverage: index.coverage, diagnostics: index.diagnostics };
    if (json) outputJson(stdout, result);
    else {
      stdout.write(`Conocimiento: ${result.status}; ${result.summary.documents} documentos, ${result.summary.edges} relaciones.\n`);
      for (const [scope, coverage] of Object.entries(index.coverage)) stdout.write(`${scope}: ${coverage.status} (${coverage.read}/${coverage.files})\n`);
      for (const finding of index.diagnostics) stdout.write(`${finding.severity} ${finding.code} ${finding.path || ''}${finding.line ? `:${finding.line}` : ''}: ${finding.message}\n`);
    }
    return partial ? 2 : invalid ? 1 : 0;
  } catch (error) {
    if (json) outputJson(stdout, { status: 'error', error: { code: error.code || 'INVALID_ARGUMENT', message: error.message } });
    else stderr.write(`Conocimiento: ${error.message}\n`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
