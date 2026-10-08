# Prueba manual del visor 0.2.0

Objetivo: comprobar si una persona puede entender el S0 y localizar la información
de una HU. La demo es ficticia; sus documentos y casillas no acreditan trabajo real.
Esta guía es una lista para ejecutar, no un registro de pruebas ya realizadas.

## Preparar

1. Instala `openspec-viewer-0.2.0.vsix` desde **Extensiones → … → Instalar
   desde VSIX** en VS Code de escritorio 1.110.0 o posterior. Recarga si se solicita.
2. Ejecuta **OpenSpec Viewer: Abrir demo local** desde la paleta de comandos.
3. Para tu proyecto usa **OpenSpec Viewer: Elegir carpeta S0** o **Abrir S0 por ruta**.
   Puedes mantener abierto el código en la misma ventana. Elegir S0 en el visor
   no configura el store de la sesión del agente.

## Recorrido visual y funcional

- [ ] Inicio muestra sistema, carpeta, descripción con su fuente y **Datos ficticios**
  sólo para la demo. Explica HU, specs, contexto y archivo; muestra archivos de plantilla.
- [ ] Hay dos HU en curso en la demo. Sus documentos se nombran completos, sin P·S·D·T.
- [ ] `catalog-search` presenta su propósito, documentos del cambio y **Siguiente
  paso sugerido**, con **Inferido** y la base. El paso Archivo no es un botón.
- [ ] Las pestañas admiten flechas izquierda/derecha y anuncian cuál está seleccionada.
  Los documentos ausentes de `export-summary` indican **falta**.
- [ ] La spec del catálogo muestra requisitos, escenarios y términos normativos
  explicados. Alternar **Estructurada / Markdown** conserva el documento y su origen.
- [ ] **Tareas** muestra 2 de 5 casillas, agrupadas por sección. Los filtros cambian
  la lista visible, pero no los archivos. Ninguna marca es un control editable.
- [ ] Contexto muestra intenciones, documentos y componentes. Una intención sin
  enlace explica qué falta y no actúa como un botón vacío.
- [ ] Archivo muestra la fecha del prefijo de la carpeta con su fuente. No acredita
  despliegue, aprobación o que el código se haya integrado.
- [ ] Ctrl/Cmd+K busca una palabra del contenido; los ámbitos HU/Specs/Contexto
  filtran resultados. Flechas y Enter navegan; Esc cierra y devuelve el foco.
- [ ] **Cómo leer este S0** abre el glosario; Tab permanece en el diálogo y Esc
  vuelve al control que lo abrió. Comprueba también estos pasos sólo con teclado.
- [ ] Ctrl+F permite buscar dentro del panel mediante el control nativo de VS Code.
- [ ] Un diagrama se puede ampliar, ajustar y cerrar con Esc conservando el foco.
- [ ] **Abrir Markdown** abre el archivo en el editor. Guardar una edición allí
  actualiza el visor; deshacer y guardar revierte ese cambio.
- [ ] Si se ofrece **Copiar**, copia sólo texto y anuncia el resultado; no ejecuta
  comandos. No se inventa un comando de implementación cuando S0 no lo define.

## Temas, tamaño y estados

- [ ] Probar oscuro, claro y alto contraste, con superficies `editor` y `personal`.
- [ ] Probar lectura 14/15/16 px, incluida una configuración cambiada con el panel abierto.
- [ ] Probar anchos aproximados de 1280, 600 y 420 px. En estrecho aparecen secciones
  con texto, el siguiente paso sigue visible y no se desplaza horizontalmente la página.
- [ ] Sin carpeta, carpeta inválida, S0 sin HU, documento ausente y error de lectura
  muestran causa y acción pertinente. Cancelar el selector conserva el S0 anterior.
- [ ] Mermaid inválido muestra un diagnóstico y permite copiarlo sin ejecutar código.
- [ ] La demo funciona sin red. Los enlaces web sólo se abren por una acción del usuario.
- [ ] Cerrar y reabrir conserva la carpeta y preferencias de lectura pertinentes.

## Catálogo grande e historial

- [ ] En un S0 de laboratorio con más de 2.000 Markdown archivados, abrir specs,
  contexto y HU activas; deben seguir disponibles y tener paginación independiente.
- [ ] Recorrer páginas de Archivo y abrir una HU. Antes de cargar su detalle,
  las tareas deben figurar pendientes de carga, nunca como ausentes por inferencia.
- [ ] Recorrer los documentos de una HU grande y comprobar que sus artefactos
  base siguen accesibles al cambiar de página.
- [ ] Buscar una spec fuera de la página visible y abrirla. Buscar en Archivo
  expresamente; Todo no debe mezclar resultados históricos con fuentes vigentes.
- [ ] Cambiar de S0 mientras se carga una página o documento. Ninguna respuesta
  o error de la carpeta anterior debe reemplazar la selección actual.
- [ ] Si una lectura falla o alcanza un límite, comprobar la categoría afectada,
  el mensaje y la acción para reintentar o seguir navegando, sin falsos ausentes.

## Recorridos de usabilidad pendientes

Medir tiempo, errores y confianza del 1 al 5 con personas reales. Comparar las
mismas tareas antes y después; no atribuir mejoras sin ejecutar la comparación.

| Recorrido | Tarea | Qué observar |
| --- | --- | --- |
| R1 · Abrir S0 | Desde el código, abrir S0 y explicar qué sistema/carpeta se consulta. | Distingue visor, código y sesión del agente; puede volver tras elegir una carpeta inválida. |
| R2 · Entender una HU | Explicar propósito, documentos pendientes y estado de las casillas. | Cita las fuentes y no interpreta casillas o documentos presentes como aprobación. |
| R3 · Encontrar contexto | Desde una delta, consultar la spec consolidada y contexto relacionado; volver a la HU. | Distingue cambio propuesto de estado documentado; identifica fuentes faltantes. |

## Límites

El panel sólo lee. No ejecuta agentes, CLI, tareas ni despliegues. Los archivos
deben permanecer dentro de S0, sin enlaces simbólicos ni junctions, y se limita
cada documento a **1 MiB**. Las imágenes Markdown se representan como texto.
La búsqueda en Todo excluye el historial; el ámbito Archivo lo consulta de forma
explícita. Un resultado sin datos no implica que el proyecto carezca de ellos:
revisa también los avisos de cobertura, límites o errores de lectura.

Las [pruebas técnicas](validacion.md) no sustituyen esta evaluación de usabilidad.
