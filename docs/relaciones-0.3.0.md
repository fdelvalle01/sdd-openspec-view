# Relaciones documentales en 0.3.2

Abre un S0 y entra en **Grafo del S0**. El mapa agrupa contexto, plantilla, herramientas,
componentes, capacidades, HDU activas e historia. Selecciona una zona, después una
entrada, para consultar su vecindario y sus fuentes. Una propuesta abre el delta
existente aunque todavía no haya una spec consolidada.

El archivo histórico se carga al activarlo. Las menciones inferidas también requieren
activar su filtro; una mención no demuestra una dependencia ni una aprobación.
Las relaciones explícitas y estructurales conservan dirección, tipo y procedencia.
La ficha ofrece apertura del documento real y la lista permite revisar las conexiones
con teclado, sin depender del dibujo del grafo.

## Navegación del grafo

El mapa organiza entradas en sectores. Un clic en una zona abre su árbol; un clic
en un documento muestra la ficha y un doble clic abre su vecindario. Al pasar el
puntero se resaltan sus conexiones. Los artefactos de una HDU se distinguen por
P (propuesta), S (spec), D (diseño), T (tareas) y R (revisión).

Arrastra el fondo para desplazar el lienzo y usa la rueda o los botones para ampliar.
Seleccionar conserva el zoom y el desplazamiento. **Encuadrar** vuelve a la posición
inicial; **Volver** recorre la navegación. **Esc** cierra primero la ficha y luego
vuelve al nivel anterior. Con teclado, **Enter** selecciona y **Shift+Enter** abre
el vecindario. **Lista accesible** ofrece las entradas sin depender de la geometría.

Las transiciones interpolan posiciones durante 520 ms y se detienen al terminar.
La preferencia del sistema para reducir movimiento las omite. En paneles estrechos
la ficha se superpone y puede cerrarse para recuperar el lienzo.

El mapa muestra hasta 30 entradas por zona; el árbol previsualiza hasta 24 conexiones
externas. Los avisos explican esos límites visuales. La lista paginada y la ficha
permiten recorrer el índice. Los recursos técnicos citados no se cuentan como
documentos de contexto y siguen accesibles en las relaciones. Los grupos visuales
organizan entradas existentes; no inventan fuentes ni dependencias.

## Comprobación manual

1. Abre un S0 sin HDU: comprueba contexto e inventario vacío sin contenido inventado.
2. Abre uno con una HDU y `revision.md`: recorre mapa, zona, HDU y documentos.
3. Selecciona una decisión o requisito desde el detalle y abre su sección real.
4. Activa y desactiva inferencias; revisa que la ficha conserve la procedencia.
5. Activa archivo y vuelve a contexto: la historia no debe desplazar documentos vigentes.
6. Cambia de S0 mientras se carga: los resultados deben pertenecer a la raíz nueva.
7. Usa Tab y Enter con anchos 600, 1040 y 1280 px. Comprueba ficha, lista de relaciones,
   foco visible, alto contraste y movimiento reducido.
8. Para archivar o renombrar documentos, usa la guía `docs/conocimiento.md` del S0:
   prepara el mapa antes del movimiento oficial, revisa el diff y aplica la reparación.

## Cobertura y distribución

Las zonas muestran páginas de 50 entradas y los vecindarios hasta 100 vecinos por
página. Esto limita la representación, sin recortar las relaciones conservadas por
el índice. El índice sí tiene presupuestos de lectura explícitos por categoría:
2.000 documentos, 32 MiB, 1 MiB por documento y profundidad 12. Una cobertura parcial
se informa y no permite afirmar que una relación no existe.

El host incorpora el motor durante el build. No ejecuta scripts del S0 elegido.
La CLI y el Viewer usan el mismo parser de Markdown y las mismas anclas; la CLI
funciona sin instalar el Viewer. Esta distribución conserva una copia exacta del
motor en `scripts/conocimiento/`, con [origen y hashes](https://github.com/fdelvalle01/sdd-openspec-view/blob/main/vendor/conocimiento.json).
No necesita una plantilla ni otro repositorio. Para usar la CLI desde este
repositorio, indica siempre el S0 mediante `--root RUTA`; por ejemplo,
`node scripts/conocimiento/cli.mjs check --root demo --json`.

La procedencia del VSIX identifica tanto el código del Viewer como el del motor.
Las pruebas automatizadas y la inspección del paquete no sustituyen la revisión
funcional o técnica de una HDU ni la aceptación visual por el usuario.
