# Evidencias de la distribución personal

Las pruebas técnicas de este paquete se registran al ejecutar la validación. No equivalen a aprobación de una HU ni sustituyen la [prueba manual de usabilidad](../../prueba-manual.md).

## Versión 0.2.0 — 8 de octubre de 2026

Esta versión elimina el cupo compartido del catálogo: cada categoría tiene su
propia página y el archivo conserva entradas sin leer sus documentos hasta
seleccionar una HU. Las pruebas de escala crean datos ficticios en carpetas
temporales; los 2.001 documentos archivados no proceden del S0 del usuario.

| Comprobación | Resultado |
| --- | --- |
| Dependencias | `npm ci --ignore-scripts --no-audit --no-fund`, Windows, Node.js 22.18.0 y npm 10.9.3. Sin dependencias nuevas. |
| Unitarias | `npm test`: 80/80 correctas, ninguna omitida. Modelo, escala, Markdown, selección de raíz, identidad y carreras del host. |
| Interfaz | `npm run test:ui`: 24/24 correctas en Edge, bundle de producción y puente de host de laboratorio. Incluye páginas independientes, carga diferida, búsqueda histórica y fuera de página, artefactos base fijos, reintentos y navegación rápida entre HU. |
| Host | `npm run test:host`: 15/15 correctas en VS Code 1.141.0, con perfil y extensiones aislados. Comprueba también selección fuera de página, refresh y reset al cambiar de S0. |
| Escala incluida | 2.001 documentos archivados y activos; páginas independientes; artefactos base fijos; búsqueda fuera de página; fronteras de 1.999/2.000/2.001 y presupuestos de 32 MiB separados. |
| Acceso a archivos | Rechazo de traversal, junctions y alias de carpetas excluidas con distintas mayúsculas en Windows. Lectura fuera de página limitada a los árboles documentales de S0. |

El primer recorrido ampliado del host falló al consultar el catálogo mientras
todavía estaba en `loading`: el watcher podía renovar la lectura inicial.
La prueba ahora espera el snapshot de la raíz seleccionada con paginación
disponible. El recorrido definitivo sobre el bundle final pasó completo.
Los reportes y capturas locales quedan en `.local/`, fuera de Git y del VSIX.

La búsqueda tiene un índice independiente por ámbito, con un máximo de 2.000
documentos y 32 MiB por ámbito y avisos explícitos de parcialidad. Puede abrir
resultados fuera de la página visible. `Todo` no incluye el archivo: éste se
consulta expresamente. La paginación del catálogo no hereda ese cupo de búsqueda.
Cada documento mantiene el límite de 1 MiB; el recorrido tiene profundidad máxima
de 12 niveles y avisa si no puede completarlo.

La procedencia del paquete distribuido se registra en `releases/0.2.0.json`, con
commit de fuente, hashes y contenido del VSIX inspeccionado. Las versiones
anteriores y sus evidencias se conservan. La aceptación humana y las pruebas
en Linux y macOS siguen pendientes.

## Reconstrucción desde Git — 8 de octubre de 2026

Se clonó por separado la rama `feat/s0-template-viewer-personal` del repositorio
`fdelvalle01/sdd-workspace`, inicialmente en el commit
`20436e56aef75dddc2266684bba94c284f881457`. El fuente del visor personal ya estaba
versionado; esta comprobación documenta su relación con el paquete existente y
añade validación automática para futuros cambios.

| Comprobación | Resultado |
| --- | --- |
| Dependencias y build | `npm ci --ignore-scripts --no-audit --no-fund` y `npm run build` correctos en Windows, Node.js 22.18.0 y npm 10.9.3. |
| Reconstrucción de 0.1.3 | Los bytes de `dist/extension.cjs`, `media/view.js` y `dist/THIRD-PARTY-NOTICES.txt` coinciden con sus entradas en el VSIX conservado en Git. El registro de procedencia en `releases/0.1.3.json` identifica el commit, el lockfile y los hashes. No se afirma igualdad binaria del ZIP completo. |
| Unitarias | 49/49 correctas. |
| Interfaz | 18/18 correctas en Edge tras corregir la selección de las HU de prueba por identificador. La primera ejecución falló porque elegía la primera tarjeta, cuyo orden depende de las fechas de los archivos al clonar. La corrección afecta únicamente al recorrido de prueba. |
| Host | 11/11 correctas con VS Code 1.141.0, perfil y extensiones aislados. |
| Empaquetado e inspección | YAML del workflow parseado sin errores; su paso de empaquetado, inspección y generación de manifiesto ejecutado localmente: candidato de 28 archivos válido, con identidad personal y sin fuentes, pruebas, perfiles ni registros de procedencia históricos dentro del VSIX. El paquete histórico conserva su SHA256. |

El workflow nuevo ejecuta instalación, unitarias, build, interfaz e inspección
del VSIX en Windows; genera un manifiesto con el commit y hash de cada candidato.
La ejecución remota se consulta en GitHub Actions: los resultados locales de
esta tabla no acreditan por sí solos una ejecución de CI. Las pruebas de host
permanecen locales. No se modificaron el código funcional del visor, sus
dependencias, el VSIX distribuido, la plantilla ni perfiles personales.

Siguen pendientes los recorridos humanos y la validación en Linux y macOS.

## Versión 0.1.3 — 7 de octubre de 2026

Resultados de esta distribución personal, ejecutados en Windows con Node.js 22.18.0. No se modificaron la plantilla de S0 ni los perfiles habituales del editor.

| Comprobación | Resultado |
| --- | --- |
| `npm test` | 49/49 correctas, ninguna omitida: lectura segura y estructurada, búsqueda, fechas, diagramas, rutas e identidad personal. Incluye índice compartido por consultas concurrentes y recuperación tras un fallo. |
| `npm run test:ui` | 18/18 correctas en Edge real, con bundle de producción y puente de host de laboratorio: navegación, teclado y foco, specs y tareas, búsqueda, glosario, Mermaid, errores, temas y anchos de 1280, 600 y 420 px. Sin solicitudes externas durante el recorrido. |
| `npm run test:host` | 11/11 correctas en VS Code 1.141.0 con perfil y extensiones aislados: identidad, comandos, comunicación real del panel, configuración, búsqueda y actualización al guardar, crear y eliminar documentos. |
| Identidad | `fdelvalle01.openspec-viewer@0.1.3`; comandos y preferencias `sddWorkspaceViewer`, icono genérico y fuentes del sistema. |
| Compilación | Bundles del host y del panel generados con las dependencias fijadas y sus avisos; sin frameworks ni dependencias nuevas. |

El host se comprobó con el ZIP oficial de Microsoft 1.141.0, verificado por SHA256: el editor instalado tenía una actualización en curso y se conservó intacto. Los registros están en `.local/`, fuera de Git y del paquete. Las pruebas de esta versión se ejecutaron sobre el código personal; no se atribuyen resultados de otros paquetes.

La búsqueda excluye archivados y bloques de código, limita cada archivo a 1 MiB, el conjunto a 32 MiB y el inventario a 2000 documentos; avisa si los resultados son parciales. Las sugerencias distinguen inferencias de evidencia y no ejecutan comandos.

**Límites:** no se probó Linux o macOS. Ctrl+F se verificó mediante la opción nativa habilitada del panel, sin un recorrido físico del teclado en VS Code. La prueba de UI utiliza un puente simulado; el host usa VS Code real. La aceptación humana y los recorridos de [usabilidad](../../prueba-manual.md) siguen pendientes. Los datos de la demo son ficticios.

## Registro histórico: 1 de octubre de 2026

| Comprobación | Resultado |
| --- | --- |
| Dependencias | Instaladas desde `package-lock.json` con `npm ci --ignore-scripts --no-audit --no-fund`. |
| Compilación | Bundles del host y del panel generados; avisos de dependencias incluidos. |
| `npm test` | 28/28 correctas, ninguna omitida: lectura segura, Markdown, índice, tareas, sugerencias y selección de rutas. |
| `npm run test:ui` | Recorrido completo en Edge sin interfaz visible: demo, HU, lector, contexto, Mermaid, temas y paneles de 900 y 420 px. Sin solicitudes externas desde la interfaz. |
| `npm run test:host` | 8/8 correctas en VS Code 1.140.0, con perfil aislado: identidad, comandos, comunicación del panel, S0 fuera de la carpeta abierta y actualización al guardar, crear y eliminar documentos. |
| VSIX | Paquete de 27 archivos con la identidad `fdelvalle01.openspec-viewer@0.1.0`, tema genérico y avisos de dependencias. Archivos empaquetados inspeccionados, sin tipografías incorporadas, material de diseño ni fixtures privados. |
| Instalación conjunta | Ambos paquetes instalados en un perfil temporal; se verificaron identidades distintas y ausencia de comandos repetidos. No se verificó interacción simultánea entre sus paneles. |

El sandbox bloqueó inicialmente la creación de procesos de Node y esbuild con `EPERM`. Las mismas comprobaciones pasaron al ejecutarlas fuera de ese sandbox, conservando fixtures y perfiles aislados. No se alteró el perfil habitual del editor.

Los registros y capturas de desarrollo quedan en `.local/`, fuera del paquete y de Git. El recorrido de interfaz es automatizado; la prueba manual de utilidad y usabilidad sigue pendiente.

La demo es una simulación. Ningún resultado histórico de otro paquete acredita la validación de esta distribución.

## Version 0.3.0: relaciones documentales

Validacion local en Windows, 2026-10-08: 86 pruebas unitarias, 27 comprobaciones de interfaz en Edge y 16 comprobaciones en un host real de VS Code con perfil aislado; todas aprobadas en cada edicion. El motor compartido tiene ademas 30 pruebas de parser, consultas, escala y movimientos.

Se comprobo mapa, zonas, vecindarios y fuentes a 600, 1040 y 1280 px; teclado, contraste, movimiento reducido, paginacion de relaciones/evidencias, archivo e inferencias optativos y referencias fuera de la pagina del catalogo. La CLI y el host producen el mismo indice con las mismas opciones.

El VSIX incluye el motor compilado; su procedencia identifica ambos directorios de fuente. Un S0 creado desde Plantilla instala dependencias propias y consulta conocimiento sin el distribuidor ni el Viewer. Las pruebas no acreditan aceptacion humana ni ejecucion de CI remoto o plataformas no probadas localmente. Consulta [el uso y los limites](../../relaciones-0.3.0.md).
