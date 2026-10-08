# Catálogo de recursos

> **Simulación:** especificación canónica ficticia. La búsqueda descrita en `catalog-search` aún es una propuesta y no forma parte de esta versión.

## Purpose

Permitir consultar una lista de recursos de ejemplo y abrir sus fichas.

## Requirements

### Requirement: Consultar el catálogo

El sistema SHALL mostrar una lista de recursos con nombre y descripción corta.

#### Scenario: Hay recursos disponibles

- **WHEN** la persona abre el catálogo
- **THEN** se muestra la lista de recursos disponibles

#### Scenario: El catálogo está vacío

- **WHEN** no hay recursos registrados
- **THEN** se muestra un mensaje que explica que la lista está vacía

### Requirement: Consultar la ficha de un recurso

El sistema SHALL mostrar el nombre y la descripción del recurso seleccionado.

#### Scenario: Recurso disponible

- **WHEN** la persona selecciona un recurso de la lista
- **THEN** se muestra su ficha con nombre, descripción y acceso al catálogo

#### Scenario: Recurso inexistente

- **WHEN** el recurso solicitado no está disponible
- **THEN** se muestra un mensaje informativo y acceso al catálogo
