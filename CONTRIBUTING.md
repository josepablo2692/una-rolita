# Guía de contribución — Una Rolita

## Flujo de ramas (Trunk-Based simplificado)

- `main` — siempre desplegable. Protegida: no se puede subir código directo, solo vía Pull Request aprobado con checks de CI en verde.
- `develop` — rama de integración antes de pasar a `main` (ambiente de staging).
- `feature/<nombre-corto>` — una rama por tarea. Ejemplos:
  - `feature/queue-redis-lock`
  - `feature/credit-purchase-flow`
  - `fix/duplicate-song-cooldown`

## Convención de commits (Conventional Commits)

```
<tipo>(<alcance opcional>): <descripción corta en minúsculas>
```

Tipos permitidos:
- `feat:` una funcionalidad nueva
- `fix:` corrección de un bug
- `docs:` cambios solo de documentación
- `refactor:` cambio de código que no agrega funcionalidad ni corrige bugs
- `test:` agregar o corregir pruebas
- `chore:` tareas de mantenimiento (dependencias, configuración)

Ejemplos:
```
feat(queue): agregar lock distribuido con Redis para asignar posición
fix(credits): corregir doble acreditación al confirmar transferencia
docs(adr): agregar decisión sobre estrategia de locking en la cola
```

## Proceso de Pull Request

1. Crea tu rama desde `develop`: `git checkout -b feature/nombre-de-la-tarea`
2. Haz commits pequeños y descriptivos.
3. Sube tu rama: `git push origin feature/nombre-de-la-tarea`
4. Abre un Pull Request hacia `develop` usando la plantilla incluida.
5. Espera que el CI corra lint + tests. Si falla, corrige antes de pedir revisión.
6. Se necesita al menos 1 aprobación antes de mergear (cuando el equipo crezca, ajustar a 2).
7. Al mergear, borra la rama.

## Antes de cada Pull Request, verifica

- [ ] Los tests pasan localmente (`pnpm test`)
- [ ] El lint pasa (`pnpm lint`)
- [ ] Actualizaste el Swagger/OpenAPI si agregaste o cambiaste un endpoint
- [ ] Si tomaste una decisión de arquitectura relevante, agregaste un ADR en `docs/adr`
