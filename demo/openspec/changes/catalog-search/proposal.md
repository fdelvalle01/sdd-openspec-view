# Búsqueda en el catálogo

> **Simulación:** propuesta ficticia para probar el visor. No representa una HU real ni una aprobación.

## Por qué

El catálogo de ejemplo muestra todos los recursos en una sola lista. Cuando crece, encontrar un recurso por su nombre exige recorrerla completa.

## Qué cambia

Agregar una búsqueda por nombre, conservar el acceso a la ficha y explicar cuándo no hay coincidencias.

| Situación | Comportamiento propuesto |
| --- | --- |
| Texto vacío | Mostrar todos los recursos |
| Nombre con coincidencias | Mostrar solo las coincidencias |
| Texto sin coincidencias | Mostrar un estado vacío y permitir limpiar |

## Capacidades

- Modificada: `catalog`, para añadir búsqueda por nombre.

## Impacto

`catalog-web` incorporaría el control de búsqueda y `catalog-api` admitiría el filtro. `catalog-data` conservaría el formato actual. Esta propuesta no incluye ordenación avanzada ni búsqueda por etiquetas.

El contexto de los componentes está en el [mapa del sistema](../../../docs/project.md).
