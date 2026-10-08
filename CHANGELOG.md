# Cambios

## 0.3.2

- Distribución independiente en `sdd-openspec-view`, con motor vendorizado y procedencia verificable; conserva la identidad y el comportamiento de la entrega personal aceptada.
- Recupera la composición del handoff de Claude: entradas radiales por zona, árbol con conexiones externas y vecindarios con artefactos y grupos.
- Mantiene el lienzo SVG y el zoom al seleccionar; anima las posiciones durante 520 ms, con alternativa sin movimiento.
- Añade ficha adaptable, barra flotante, glifos por tipo, tooltip, resaltado de conexiones y navegación con teclado.
- Conserva relaciones, procedencia y paginación; los recursos citados siguen accesibles sin contarse como documentos de contexto.
- Incluye pruebas de geometría, interacción, ciclo de vida y comparación visual en varios tamaños. No agrega dependencias.

## 0.3.1

- Corrige el grafo que permanecia cargando al seleccionar rutas Windows con distinta capitalizacion o alias.
- Unifica la identidad fisica de S0 y demo sin debilitar el rechazo de mensajes de otra raiz.
- Agrega regresiones del protocolo de mensajes y conserva la etiqueta de datos de demo.

## 0.3.0

- Grafo local con zonas, vecindarios, ficha de procedencia y lista accesible.
- Motor de relaciones compartido con la CLI de S0, independiente de la paginacion.
- Apertura de fuentes y anclas; consulta de decisiones, tareas y requisitos.
- Cobertura explicita, inferencias optativas y lectura del archivo separada.


## 0.2.0 · Catálogo independiente e historial bajo demanda

- Páginas independientes para HU activas, specs, contexto y archivo: el historial
  deja de consumir el límite de documentos de las fuentes vigentes.
- HU archivadas listadas sin leer sus documentos; el detalle se carga al abrirlas.
- Navegación por páginas de documentos de una HU, conservando sus artefactos base.
- Estados de carga parcial, pendiente y error diferenciados de archivos ausentes.
- Búsqueda por ámbito con límites independientes y filtro Archivo explícito;
  los resultados pueden abrirse aunque estén fuera de la página visible.
- Lecturas y respuestas tardías descartadas al cambiar de S0 o de selección.
- Conserva identidad personal, modo de sólo lectura y protecciones de rutas.

## 0.1.3 · Lectura y navegación v2

- Inicio que explica S0, sus zonas y los archivos presentes de la plantilla.
- HU con flujo de documentos en palabras, pestañas accesibles y siguiente paso
  inferido visible también en un panel estrecho.
- Specs estructuradas por requisitos y escenarios, con glosas normativas y modo
  Markdown; tareas por sección con filtros que no modifican sus archivos.
- Búsqueda local de contenido con Ctrl/Cmd+K, avisos ante límites y glosario.
- Contexto por índice, incluidos índices en tablas; relaciones inversas con HU.
- Superficies del editor o tema personal, lectura de 14/15/16 px y Ctrl+F nativo.
- Identidad, comandos, icono genérico y fuentes del sistema conservados. Sin nuevas
  dependencias ni instalaciones en perfiles como parte del uso del visor.

## 0.1.0

- Distribución personal del visor con identidad y comandos independientes.
- Inicio, HU, lector, contexto por intención, specs y archivados.
- Demo ficticia de catálogo y apertura de cualquier S0 por carpeta o ruta.
- Tema local oscuro, claro y alto contraste, con fuentes del sistema.
- Código, pruebas y paquete VSIX dentro de la misma distribución.

El visor conserva un alcance de lectura y no interpreta documentos presentes o tareas marcadas como aprobación o ejecución verificada.
