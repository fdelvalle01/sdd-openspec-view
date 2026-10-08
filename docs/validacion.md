# Validación de la distribución independiente

Comprobaciones locales del 8 de octubre de 2026 sobre OpenSpec Viewer Personal
0.3.2, en Windows con Node.js 22.18.0, npm 10.9.3, Microsoft Edge y VS Code
1.141.0. Las suites se ejecutaron en serie, con demo ficticia y perfiles aislados.

| Comprobación | Resultado |
| --- | --- |
| Instalación | `npm ci --ignore-scripts --no-audit --no-fund` completado; dependencias y lockfile conservados. |
| Motor | `npm run verify:vendor`: cinco módulos byteidénticos al origen, con SHA256, blobs y árbol Git comprobados. |
| Unitarias | `npm test`: 110/110 aprobadas, sin fallos, cancelaciones ni omisiones; 107 existentes y tres de distribución independiente. |
| Build | `npm run build`: bundles del host y la interfaz, con avisos de dependencias generados correctamente. |
| Interfaz | `npm run test:ui`: 31/31 comprobaciones aprobadas en Edge con bundle de producción; navegación, temas, archivos, búsqueda, grafo, teclado y movimiento reducido. Sin errores JavaScript ni solicitudes externas del recorrido. |
| Host | `npm run test:host`: 16/16 comprobaciones aprobadas en VS Code real, con perfiles y extensiones aislados; comunicación del panel, selección de S0, grafo, búsqueda y watchers. |
| Independencia | El bundle del host resuelve todos sus inputs dentro de este repositorio. La raíz carece de OpenSpec e inventario de una aplicación; los ejemplos están en `demo/`. |
| Fidelidad del fuente | Todos los archivos de `src/` coinciden con el origen salvo los dos imports hacia el motor local. Icono y tokens de tema intactos; en CSS sólo cambia un comentario de identificación. |
| Empaquetador | `scripts/package.ps1` validado con el parser de Windows PowerShell 5.1 y revisado junto con el workflow. Requiere un commit y fuente limpio antes y después del build. |

Los informes locales se conservan en `.local/unit-tests.log`,
`.local/ui/v2-report.json` y `.local/host-smoke-PTBKDj/result.json`; las capturas
están en `.local/ui/`. No se incluyen en Git ni en el VSIX. El motor también
se verificó contra los bytes del checkout de origen; las pruebas de integridad
pueden repetirse sin ese checkout mediante el registro vendorizado.

## Fuente y procedencia del paquete

La extracción parte de
[SDD Workspace 37b0f78](https://github.com/fdelvalle01/sdd-workspace/tree/37b0f7876bcb25f9308cbb3cd82b54c0ea052474/View-OpenSpec),
árbol Viewer `ee9281fb5d611ec21fd47fd09e92aa925955d370`. El motor procede del
árbol `9a5f9f22f10881b548606edc9fefdfa47740c737`, conservado sin cambios en
`scripts/conocimiento/`. El [registro de origen](https://github.com/fdelvalle01/sdd-openspec-view/blob/main/vendor/conocimiento.json)
fija las cinco rutas y sus hashes.

La [procedencia distribuida de 0.3.2](https://github.com/fdelvalle01/sdd-openspec-view/blob/main/releases/0.3.2.json)
identifica el commit y árbol propios, `sourceDirectory: "."`, árbol del motor,
lockfile, SHA256 y contenido del instalador inspeccionado. El comando
`npm run package` genera primero el candidato y su manifiesto en `artifacts/`;
la copia a la raíz y a `releases/` es una acción de distribución posterior.

Los [registros históricos](https://github.com/fdelvalle01/sdd-openspec-view/blob/main/docs/history/sdd-workspace/README.md)
mantienen íntegros los JSON del repositorio anterior. Sus commits, paquetes y
resultados no corresponden a esta extracción. El árbol actual conserva sólo
el instalador vigente; los anteriores permanecen en el historial de origen.

## Límites de la evidencia

Estos resultados son locales; no acreditan una ejecución remota de GitHub
Actions, publicación en Marketplace ni pruebas en Linux o macOS. La suite de
interfaz usa un puente de laboratorio; la suite de host usa VS Code real.
No se garantiza una tasa fija de cuadros por segundo ni aceptación de una HDU.
La extracción conserva el diseño y comportamiento de la entrega personal 0.3.2.
La [prueba manual](prueba-manual.md) describe los recorridos para revisiones futuras.
