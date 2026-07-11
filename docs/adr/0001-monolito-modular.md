# ADR 0001 — Monolito modular en vez de microservicios para el MVP

## Estado
Aceptado

## Contexto
Una Rolita empieza como MVP para validar con 1 a 5 locales. Se evaluó microservicios completos desde el inicio versus un monolito modular.

## Decisión
Se construye un monolito modular en NestJS con módulos separados por dominio (auth, venues, queue, credits, dedications, spotify, admin, notifications). Cada módulo tiene límites claros para poder extraerse como microservicio independiente en el futuro sin reescribir lógica de negocio.

## Consecuencias
- Menor complejidad operativa y de despliegue durante la validación del producto.
- Cuando el tráfico lo justifique, los primeros candidatos a extraer son `credits` (pagos) y `spotify` (integración externa), por ser los que más necesitan aislar fallos y escalar de forma independiente.
- Se requiere disciplina en no acoplar módulos directamente (usar eventos internos en vez de llamadas directas entre módulos) para que la futura extracción sea de bajo costo.
