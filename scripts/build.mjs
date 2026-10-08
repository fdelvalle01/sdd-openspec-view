import { build } from 'esbuild';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
await mkdir('dist', { recursive: true });
await mkdir('media', { recursive: true });
await mkdir('artifacts', { recursive: true });
const results = await Promise.all([
  build({ entryPoints: ['src/extension.js'], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['vscode'], outfile: 'dist/extension.cjs', sourcemap: false, logLevel: 'info', metafile: true }),
  build({ entryPoints: ['src/webview.js'], bundle: true, platform: 'browser', target: 'chrome132', format: 'iife', outfile: 'media/view.js', minify: true, sourcemap: false, logLevel: 'info', metafile: true }),
]);
// Preserve upstream license texts for dependencies shipped inside the bundles.
const packageRoots = new Set();
for (const result of results) {
  for (const file of Object.keys(result.metafile.inputs)) {
    const normalized = file.replaceAll('\\', '/');
    const marker = normalized.lastIndexOf('node_modules/');
    if (marker < 0) continue;
    const tail = normalized.slice(marker + 13).split('/');
    const count = tail[0].startsWith('@') ? 2 : 1;
    packageRoots.add(normalized.slice(0, marker + 13) + tail.slice(0, count).join('/'));
  }
}
const notices = ['THIRD-PARTY NOTICES\n\nUpstream licenses for dependencies included in this private extension.\n'];
for (const folder of [...packageRoots].sort()) {
  const pkg = JSON.parse(await readFile(path.join(folder, 'package.json'), 'utf8'));
  notices.push(`\n${'='.repeat(72)}\n${pkg.name} ${pkg.version}\nLicense: ${JSON.stringify(pkg.license || pkg.licenses || 'See upstream package')}\n`);
  const licenses = (await readdir(folder)).filter(name => /^(licen[sc]e|copying|notice)(\.|$)/i.test(name));
  for (const name of licenses) notices.push(`\n--- ${name} ---\n${await readFile(path.join(folder, name), 'utf8')}`);
}
await writeFile('dist/THIRD-PARTY-NOTICES.txt', notices.join('\n'), 'utf8');
