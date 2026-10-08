# OpenSpec Viewer · Personal

Visor local para leer un S0 OpenSpec desde la misma ventana de VS Code donde trabajas con el código. Reúne cambios, especificaciones, contexto e inventario de componentes. Funciona con cualquier sistema y no necesita una cuenta IA, OpenSpec CLI ni un servidor.

## Instalar y abrir

Requiere VS Code de escritorio **1.110.0 o posterior**.

1. Descarga [openspec-viewer-0.3.2.vsix](https://github.com/fdelvalle01/sdd-openspec-view/raw/refs/heads/main/openspec-viewer-0.3.2.vsix).
2. En VS Code abre **Extensiones → … → Instalar desde VSIX…** y selecciona el archivo. Recarga la ventana si VS Code lo solicita.
3. Abre `Ctrl+Shift+P`, ejecuta **OpenSpec Viewer: Elegir carpeta S0** y selecciona la raíz de tu sistema, donde está `openspec/`.

Para probar sin preparar un sistema, ejecuta **OpenSpec Viewer: Abrir demo local**. La demo contiene datos ficticios; nunca representa aprobaciones o trabajo real.

Si el selector de carpetas no te resulta cómodo, usa **OpenSpec Viewer: Abrir S0 por ruta**. Admite rutas absolutas con espacios y comillas. Puedes mantener abierto tu repositorio de código y consultar un S0 situado en otra carpeta.

Selecciona la carpeta del **S0 que quieres consultar**, donde está `openspec/`.
Este repositorio distribuye el Viewer y una demo ficticia; no es el S0 de una
aplicación. El visor tampoco registra stores ni configura las skills del agente.

## Qué muestra

- Inicio con identidad, carpeta, organización de S0 y archivos presentes de la plantilla.
- Detalle de HU con flujo en palabras, documentos pendientes y siguiente paso inferido visible también en paneles estrechos.
- Specs como requisitos y escenarios, términos normativos explicados y alternativa Markdown.
- Tareas por sección con filtros Todas / Pendientes / Marcadas, sin editar casillas.
- Búsqueda local de títulos y contenido con **Ctrl/Cmd+K**, ámbitos HU/Specs/Contexto y navegación con teclado. **Archivo** busca expresamente en el historial; **Todo** incluye sólo las fuentes vigentes.
- Glosario **Cómo leer este S0**, con definiciones y límites de los indicadores.
- Contexto por intención cuando existe `docs/INDICE.md`, incluidos índices en tablas; inventario desde `repositorios.json`.
- Markdown, tablas, índice de encabezados y diagramas Mermaid ampliables.
- Páginas independientes de cambios activos, archivo, specs y contexto. Los documentos de una HU archivada se cargan al abrirla.
- Specs consolidadas y deltas diferenciados; carga pendiente, parcial o fallida indicada sin presentarla como ausencia de archivos.
- Actualización al guardar, crear o eliminar documentos.

**Es de solo lectura.** Las casillas marcadas y los documentos presentes no acreditan aprobación, pruebas ni aceptación. El siguiente paso es una sugerencia calculada a partir de los archivos; no es el estado oficial de OpenSpec. **Abrir Markdown** abre el archivo original en el editor para que decidas si quieres editarlo.

| Comando | Identificador |
| --- | --- |
| OpenSpec Viewer: Abrir visor | `sddWorkspaceViewer.open` |
| OpenSpec Viewer: Abrir demo local | `sddWorkspaceViewer.demo` |
| OpenSpec Viewer: Elegir carpeta S0 | `sddWorkspaceViewer.selectRoot` |
| OpenSpec Viewer: Abrir S0 por ruta | `sddWorkspaceViewer.openPath` |
| OpenSpec Viewer: Actualizar visor | `sddWorkspaceViewer.refresh` |

Esta distribución usa la identidad `fdelvalle01.openspec-viewer` y comandos propios. No reemplaza otras extensiones de identidad distinta ni importa automáticamente su configuración.

En **Configuración → OpenSpec Viewer · Personal** puedes elegir
`sddWorkspaceViewer.readingSize` (14, 15 o 16 px) y `sddWorkspaceViewer.surfaces`
(`editor` o `personal`). Por defecto usa las superficies del editor y lectura de
15 px. El alto contraste respeta el tema de VS Code. **Ctrl+F** abre la búsqueda
nativa dentro del panel. La navegación conserva textos cuando divides el editor.

## Límites

El visor procesa archivos locales y no envía su contenido a servicios externos. Los enlaces web se abren en el navegador sólo al pulsarlos. Las imágenes Markdown se muestran como texto descriptivo. No se siguen enlaces simbólicos o junctions; los documentos y sus enlaces locales deben permanecer dentro del S0 seleccionado y no superar 1 MiB.

Cada categoría tiene páginas independientes. El historial no puede desplazar las
specs ni el contexto del catálogo. La búsqueda recorre el ámbito elegido aunque
sus documentos no estén en la página visible, con un máximo de 2.000 documentos
y 32 MiB por ámbito. **Todo** reúne HU activas, specs y contexto; el archivo se
consulta por separado. Los límites y errores se informan como resultados parciales,
sin afirmar que un archivo omitido no exista. Cambiar de página no cambia las specs
ni mueve documentos en disco.

Los temas oscuro, claro y alto contraste usan fuentes del sistema y de VS Code, sin descargar tipografías. No incluye edición dentro del panel, ejecución de agentes, registro de stores ni sincronización remota.

## Desarrollar y empaquetar

El fuente vive en la raíz de [sdd-openspec-view](https://github.com/fdelvalle01/sdd-openspec-view):
`src/`, `tests/`, `scripts/`, recursos y `package-lock.json`. No requiere
repositorios vecinos. El motor está vendorizado en `scripts/conocimiento/`;
su [registro de origen](https://github.com/fdelvalle01/sdd-openspec-view/blob/main/vendor/conocimiento.json) fija commit, árbol y hashes.
La [procedencia de 0.3.2](https://github.com/fdelvalle01/sdd-openspec-view/blob/main/releases/0.3.2.json) identifica el paquete construido
desde este repositorio. Los [registros anteriores](https://github.com/fdelvalle01/sdd-openspec-view/blob/main/docs/history/sdd-workspace/README.md)
corresponden a SDD Workspace y no acreditan un build de esta distribución.

Desde esta carpeta, con Node.js **22.14 o posterior** y npm:

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run verify:vendor
npm test
npm run build
npm run test:ui
npm run test:host
npm run package
```

`test:ui` necesita Microsoft Edge instalado; `test:host` necesita VS Code de
escritorio y acepta `VSCODE_EXECUTABLE` si el ejecutable está en otra ubicación.
Las pruebas usan copias de la demo y perfiles aislados. Sus informes quedan
bajo `.local/`, sin instalar la extensión en el perfil habitual.

`npm run package` usa PowerShell y requiere el fuente confirmado en Git. Genera
un candidato en `artifacts/`, inspecciona su contenido y escribe un manifiesto
de procedencia. No sustituye automáticamente el instalador distribuido. Para
una entrega, copia el candidato a la raíz y su manifiesto a
`releases/0.3.2.json` después de comprobar las pruebas. Sólo se conserva el VSIX
vigente en el árbol actual. Los avisos de dependencias agrupadas están en
`dist/THIRD-PARTY-NOTICES.txt`. El código propio conserva `UNLICENSED`.

El [workflow del visor](https://github.com/fdelvalle01/sdd-openspec-view/blob/main/.github/workflows/viewer.yml) valida push y pull request,
incluidos cambios al motor. En Windows y Node.js 22.18.0 instala el lockfile,
verifica la copia del motor, ejecuta unitarias e interfaz, compila e inspecciona
el paquete. Publica un artefacto de Actions con VSIX y procedencia: commit,
árboles del fuente y motor, SHA256, lockfile y contenido empaquetado.
Los artefactos de CI son candidatos. No hay publicación automática en Marketplace
ni sustitución del instalador en Git. La prueba con el host real sigue siendo
un paso local antes de distribuir, junto con la revisión manual.

Para depurar, abre esta carpeta en VS Code, ejecuta `npm run build` y pulsa
`F5`. Consulta la [prueba manual](docs/prueba-manual.md), las
[evidencias](docs/validacion.md) y las [instrucciones de mantenimiento](https://github.com/fdelvalle01/sdd-openspec-view/blob/main/AGENTS.md).

## Grafo del S0

La vista Grafo del S0 ofrece mapa de zonas, vecindario y ficha de relaciones con
procedencia. Puede navegar el contexto inicial sin HDU. Las menciones inferidas
y el archivo historico se habilitan expresamente.

El indice es independiente de la pagina visible. Sus advertencias distinguen
fuentes no leidas, referencias rotas y capacidades propuestas. Abrir una fuente
lleva a su documento real y, cuando corresponde, su seccion o linea.

El motor tambien se usa desde la CLI y la guia de conocimiento del S0; el VSIX
lo incluye compilado y no ejecuta codigo del proyecto seleccionado.

Consulta [uso, cobertura y comprobación manual del grafo](docs/relaciones-0.3.0.md).
