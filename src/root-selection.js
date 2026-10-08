import path from 'node:path';
import { stat, realpath } from 'node:fs/promises';
import { isOpenSpecRoot } from './model.js';

export const INVALID_ROOT = 'OPENSPEC_ROOT_INVALID';
const CODE_MARKERS = ['package.json', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'go.mod', 'Cargo.toml', 'pyproject.toml', 'requirements.txt', 'src'];

// Only a hint for the message: a build file or src/ suggests a code repository instead of an S0.
export async function looksLikeCodeRepository(folder) {
  for (const name of CODE_MARKERS) {
    try { await stat(path.join(folder, name)); return true; } catch { /* next marker */ }
  }
  return false;
}

export async function resolveRootInput(input) {
  if (typeof input !== 'string') throw new Error('Pega la ruta completa de la carpeta S0.');
  let selected = input.trim();
  if ((selected.startsWith('"') && selected.endsWith('"')) || (selected.startsWith("'") && selected.endsWith("'"))) selected = selected.slice(1, -1).trim();
  if (!selected || !path.isAbsolute(selected)) throw new Error('Pega una ruta local completa a la carpeta S0.');
  selected = path.normalize(selected);
  let entry;
  try { entry = await stat(selected); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new Error('Esa carpeta no existe. Comprueba la ruta pegada.');
    throw new Error('No se pudo acceder a esa carpeta. Comprueba los permisos de lectura.');
  }
  if (!entry.isDirectory()) throw new Error('Selecciona una carpeta, no un archivo.');
  if (path.basename(selected).toLowerCase() === 'openspec' && !await isOpenSpecRoot(selected)) selected = path.dirname(selected);
  if (!await isOpenSpecRoot(selected)) {
    const error = new Error('La carpeta debe contener openspec/config.yaml, openspec/changes o openspec/specs.');
    error.code = INVALID_ROOT;
    error.path = selected;
    error.codeRepository = await looksLikeCodeRepository(selected);
    throw error;
  }
  // The catalogue and knowledge engine use this same physical identity. In
  // Windows a URI can spell the drive as c: while realpath returns C:.
  return realpath(selected);
}
