# ADR 0002 — Posponer protección de rama `main` hasta fase de producción

## Estado
Aceptado

## Contexto
GitHub restringe la protección de ramas (revisores requeridos, status checks obligatorios) en
repositorios **privados** al plan GitHub Pro o superior. El plan Free solo permite esta función
en repositorios públicos.

En la etapa actual del proyecto:
- No hay presupuesto asignado para herramientas de pago.
- El repositorio no tiene colaboradores adicionales — un solo desarrollador con acceso.
- El proyecto no está en producción ni maneja datos ni pagos reales todavía.

## Decisión
Se pospone la protección técnica de la rama `main` hasta que ocurra alguna de estas condiciones:
1. Se incorpore presupuesto y se contrate GitHub Pro (o superior), o
2. Se sume otro colaborador al repositorio, o
3. El proyecto pase a fase de producción con datos/pagos reales.

Mientras tanto, se seguirá una **disciplina de proceso** (no una regla técnica forzada):
- No hacer push directo a `main`, incluso trabajando solo.
- Usar ramas `feature/*` y Pull Requests hacia `develop`, como ya está documentado en `CONTRIBUTING.md`.
- El CI (GitHub Actions) sigue corriendo en cada PR de todas formas, aunque no sea "obligatorio"
  técnicamente — sirve como red de seguridad informal.

## Consecuencias
- Riesgo aceptado: un error humano podría subir código roto directo a `main` sin que nada lo bloquee.
  Se considera un riesgo bajo dado que solo hay un desarrollador activo por ahora.
- Cuando se active la protección real, no se necesita ningún cambio de código — solo activar la
  configuración en GitHub (Settings > Branches), usando el mismo bloque de `setup-github.sh` que
  ya está preparado en el repo.
