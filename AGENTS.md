# Mantenimiento de OpenSpec Viewer

Este es el repositorio oficial de OpenSpec Viewer. Distribuye una extensión
de VS Code independiente, con fuente, motor y VSIX propios. SDD Workspace
mantiene la plantilla S0 y su creador y remite aquí para obtener el visor. Lee
[README.md](README.md), [validación](docs/validacion.md) y los scripts afectados.

- Conserva `fdelvalle01.openspec-viewer`, comandos y ajustes `sddWorkspaceViewer`
  y los temas existentes. La extracción conserva la versión 0.3.2.
- Fuente, pruebas, motor y recursos viven en este repositorio. No añadas imports,
  builds ni fixtures que dependan de carpetas hermanas o rutas personales.
- Mantén aquí las siguientes versiones del visor. La plantilla y su creador
  viven en SDD Workspace; no los incorpores ni los modifiques como efecto de
  mantener o empaquetar esta extensión. Su motor se mantiene por separado.
- `scripts/conocimiento/` es una copia exacta del origen documentado en
  [vendor/conocimiento.json](vendor/conocimiento.json). Para actualizarla,
  identifica y revisa el nuevo origen y actualiza sus hashes deliberadamente.
- El Viewer sólo lee el S0 seleccionado. No ejecuta sus scripts. Los datos de
  `demo/` son ficticios; no agregues inventarios ni fuentes de proyectos reales.
- No inicialices OpenSpec en esta raíz. Los ejemplos OpenSpec quedan en la demo
  o en fixtures de pruebas aislados.
- Usa el lockfile: `npm ci --ignore-scripts --no-audit --no-fund`. Ejecuta
  `npm run verify:vendor`, `npm test`, `npm run build`, `npm run test:ui` y
  `npm run test:host` según el alcance. Serializa las suites grandes.
- Usa perfiles aislados para pruebas. No instales en el perfil habitual como
  efecto de validar. Registra resultados, fallos y límites sin inventar aceptación.
- `npm run package` inspecciona el candidato y registra el commit del fuente;
  confirma el fuente antes de empaquetar. El VSIX se genera en `artifacts/`.
  Conserva únicamente el instalador vigente y su procedencia en `releases/`.
- Los registros bajo `docs/history/` describen la distribución anterior; no los
  atribuyas a esta fuente ni reemplaces sus hashes con los de builds nuevos.
