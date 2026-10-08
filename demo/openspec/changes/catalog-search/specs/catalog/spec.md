# Delta de catálogo

> **Simulación:** requisitos propuestos para el cambio `catalog-search`. La especificación canónica sigue en `openspec/specs/catalog/spec.md`.

## ADDED Requirements

### Requirement: Buscar recursos por nombre

El sistema SHALL permitir filtrar recursos por nombre sin distinguir mayúsculas.

#### Scenario: El texto coincide con recursos

- **WHEN** la persona escribe parte del nombre de un recurso
- **THEN** se muestran los recursos cuyos nombres contienen ese texto

#### Scenario: No hay coincidencias

- **WHEN** ningún nombre contiene el texto indicado
- **THEN** se muestra un estado vacío y una acción para limpiar la búsqueda

#### Scenario: El filtro está vacío

- **WHEN** la persona borra el texto de búsqueda
- **THEN** se muestra el catálogo completo
