# Una Rolita 🎵

Rocola digital para sport-bars, gimnasios y clubes nocturnos. Los clientes piden canciones desde su mesa escaneando un QR, con opción de créditos pagados, saltos de cola y dedicatorias moderadas. El DJ/administrador controla todo desde un panel en vivo.

## Estado del proyecto

El progreso real y actualizado vive en docs/backlog.md — cada Épica tiene sus tareas marcadas como hechas ([x]) o pendientes ([ ]). Ese archivo es la fuente de verdad, no este README.

## Estructura del monorepo

```
una-rolita/
├── apps/
│   ├── api/              → Backend NestJS (monolito modular)
│   │   ├── src/
│   │   │   ├── modules/  → auth, venues, queue, credits, dedications, spotify, admin, notifications
│   │   │   └── common/   → guards, decorators, filters, interceptors compartidos
│   │   └── db/           → migraciones y seeds de Postgres
│   ├── web-client/       → Next.js — la app que ve el cliente al escanear el QR
│   └── admin-panel/      → Next.js/React — panel del DJ/administrador
├── docs/
│   └── adr/              → Architecture Decision Records
└── .github/               → workflows de CI, plantillas de PR e issues
```

## Requisitos

- Node.js 20+
- Docker y Docker Compose
- pnpm (`npm install -g pnpm`)

## Cómo levantar el proyecto localmente

```bash
# 1. Clonar
git clone https://github.com/<tu-usuario>/una-rolita.git
cd una-rolita

# 2. Copiar variables de entorno
cp apps/api/.env.example apps/api/.env

# 3. Levantar Postgres y Redis con Docker
docker compose up -d

# 4. Instalar dependencias
pnpm install

# 5. Correr migraciones
pnpm --filter api run migration:run

# 6. Levantar el backend en modo desarrollo
pnpm --filter api run start:dev
```

## Documentación técnica

- Decisiones de arquitectura: [`docs/adr`](./docs/adr)
- Documentación de la API (Swagger): disponible en `/api/docs` cuando el backend está corriendo localmente
- Modelo de datos: [`apps/api/db/schema.sql`](./apps/api/db/schema.sql)
- Si es tu primera vez con este proyecto (o cambiaste de computadora), sigue docs/SETUP.md paso a paso.

## Flujo de trabajo (Git)

Ver [`CONTRIBUTING.md`](./CONTRIBUTING.md) para el flujo de ramas, convención de commits y proceso de Pull Request.

## Licencia

Propiedad privada — todos los derechos reservados.
