# Guía de configuración desde cero — Una Rolita

Este documento existe para un escenario específico: perdiste tu computadora,
la formateaste, o vas a trabajar desde otra máquina. Sigue estos pasos en
orden y quedas exactamente donde estabas.

## 1. Herramientas a instalar (una sola vez por computadora)

| Herramienta | Para qué | Link |
|---|---|---|
| Git | Control de versiones | https://git-scm.com/download/win |
| GitHub CLI (`gh`) | Crear/gestionar repos desde terminal | https://cli.github.com |
| Node.js (versión LTS) | Motor de JavaScript | https://nodejs.org |
| pnpm (v9, NO la última) | Gestor de paquetes del monorepo | `npm install -g pnpm@9` |
| Docker Desktop | Corre Postgres y Redis sin instalarlos en Windows | https://www.docker.com/products/docker-desktop/ |
| VS Code | Editor de código | https://code.visualstudio.com |

**Verifica cada una:** `git --version`, `gh --version`, `node --version`, `pnpm --version`, `docker --version`, `code --version` — todas deben responder sin error.

## 2. Extensiones de VS Code

Abre VS Code → Extensiones (`Ctrl+Shift+X`) → instala:
- ESLint
- Prettier - Code formatter
- Docker (de Microsoft)
- GitLens
- Thunder Client

## 3. Clonar el proyecto

```bash
gh auth login
git clone https://github.com/josepablo2692/una-rolita.git
cd una-rolita
```

## 4. Instalar dependencias del proyecto

Todo lo que instalamos con `pnpm add` (NestJS, TypeORM, ioredis, class-validator,
Swagger, etc.) está registrado en `package.json` y `pnpm-lock.yaml` — un solo
comando reinstala TODO exactamente en las mismas versiones:

```bash
pnpm install
```

## 5. Crear el archivo de variables de entorno

Este archivo NUNCA se sube a GitHub (por seguridad), así que hay que
recrearlo a mano, una sola vez:

```bash
Copy-Item apps\api\.env.example apps\api\.env
```

Si `.env.example` no existiera (ya nos pasó una vez), créalo con este contenido en `apps/api/.env`:

```
DATABASE_URL=postgresql://una_rolita:una_rolita_dev@localhost:5433/una_rolita
REDIS_URL=redis://localhost:6379
JWT_ACCESS_SECRET=cambia-esto-en-produccion
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_SECRET=cambia-esto-tambien
JWT_REFRESH_EXPIRES_IN=7d
NODE_ENV=development
PORT=3000
```

**Nota el puerto 5433, no 5432** — lo cambiamos porque un Postgres nativo de
Windows puede ocupar el puerto por defecto.

## 6. Levantar Postgres y Redis

Abre Docker Desktop primero (la aplicación debe estar corriendo), luego:

```bash
docker compose up -d
docker ps
```

Confirma que ambos contenedores (`una-rolita-postgres`, `una-rolita-redis`) aparecen como `Up`.

## 7. Levantar el backend

```bash
cd apps/api
pnpm run start:dev
```

Confirma en el log que aparece `Nest application successfully started`, y visita:
- `http://localhost:3000/docs` → documentación Swagger
- `http://localhost:3000/venues` → debería responder `[]` (sin datos todavía)

## Listo

En este punto estás exactamente donde estabas antes — mismo código, mismas
dependencias, mismas versiones. Lo único que se pierde al cambiar de máquina
son los datos de Postgres de PRUEBA (venues/mesas que hayas creado
manualmente) — eso es esperado y no es un problema real.