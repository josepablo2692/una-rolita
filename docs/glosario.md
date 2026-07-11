# Glosario técnico — Una Rolita

Este documento explica, en términos simples, cada concepto que vamos a usar durante el desarrollo. La idea es que sirva como referencia de aprendizaje, no solo como definición seca.

---

## Patrones de diseño (Design Patterns)

Son **soluciones ya probadas** a problemas que se repiten en programación. En vez de inventar una solución desde cero cada vez, usamos una "receta" conocida que otros programadores van a reconocer de inmediato al leer el código. Esto hace el código más fácil de mantener y de explicar en una entrevista o auditoría técnica.

### Strategy
Cuando una misma acción se puede hacer de varias formas distintas, y quieres poder cambiar la forma sin tocar el resto del sistema. En Una Rolita: la regla de cooldown (no repetir canción) puede variar por tipo de local — el `CooldownPolicy` es una "estrategia" que se puede intercambiar sin tocar el módulo de cola.

### Adapter
Convierte una interfaz externa (que no controlas) en una interfaz interna que sí controlas. En Una Rolita: `SpotifyAdapter` traduce las llamadas específicas de la API de Spotify a un lenguaje genérico (`MusicProviderAdapter`) que el resto de tu sistema entiende. Si algún día agregas Apple Music, solo escribes un nuevo adapter — el resto del código ni se entera del cambio.

### Observer (o Event Emitter)
Un componente "avisa" que algo pasó (ej. "se confirmó un pago"), y otros componentes que están interesados reaccionan a ese aviso, sin que el primero tenga que saber quién está escuchando. Evita que los módulos queden pegados unos a otros (bajo acoplamiento).

### Factory
Un componente cuya única responsabilidad es "construir" otro objeto, decidiendo cuál versión crear según el contexto. Útil cuando en el futuro tengas varios proveedores de pago y necesites decidir cuál instanciar según el país o el método elegido.

### State Machine (máquina de estados)
Define explícitamente los estados posibles de algo y qué transiciones son válidas entre ellos. En Una Rolita, una transacción de crédito solo puede moverse `pending → in_review → confirmed` o `→ rejected`, nunca al revés ni saltarse pasos. Esto evita bugs de "estados imposibles".

### Repository
Separa la lógica de negocio de la forma en que se guardan los datos (Postgres, en este caso). Tu código de negocio le pide cosas a un "repositorio" (`UserRepository.findByPhone()`), sin saber si por debajo hay SQL, otra base de datos, o incluso una API externa.

### Value Object
Un objeto que representa un **valor**, no una entidad con identidad propia. Se identifica por su contenido, no por un ID. Ejemplo: `QueueJumpPolicy` no es "una fila en la base de datos" — es una regla de negocio empaquetada (ej. "máximo 1 salto pagado por hora") que puedes validar en cualquier parte del código sin duplicar la lógica. Si cambias la regla, la cambias en un solo lugar.

---

## Concurrencia y bases de datos

### Distributed Lock (candado distribuido) con Redis — Redlock
Cuando **varios procesos o servidores** podrían intentar modificar el mismo dato al mismo tiempo (ej. dos personas pagando por saltar la cola en el mismo instante), necesitas un "candado" que solo uno pueda tomar a la vez — pero como puede haber varios servidores backend corriendo, ese candado no puede vivir solo en la memoria de un servidor. Redis (una base de datos súper rápida en memoria) se usa para guardar ese candado de forma centralizada. **Redlock** es el algoritmo específico que Redis recomienda para hacerlo de forma segura (evita que el candado se "pierda" o quede tomado por error para siempre).

Analogía: es como una sola llave física para un baño compartido — quien la tiene, entra; los demás esperan afuera hasta que la deje.

### Pessimistic Locking (bloqueo pesimista)
Una forma de manejar concurrencia en la que **asumes que va a haber conflicto**, así que bloqueas el recurso ANTES de leer/modificar, y nadie más puede tocarlo hasta que termines. Es el opuesto de "Optimistic Locking" (donde asumes que no habrá conflicto, y solo revisas al final si alguien más lo cambió mientras tanto). Para la cola de canciones, usamos pesimista porque el costo de un error (dos personas creyendo que tienen la misma posición) es alto y el volumen de conflictos reales es bajo — vale la pena pagar el costo de bloquear.

### ACID / Transacción / Unit of Work
Una **transacción** en base de datos agrupa varias operaciones para que se ejecuten todas o ninguna (ej. "restar créditos" + "confirmar pedido" deben pasar juntas, nunca una sin la otra). **Unit of Work** es el patrón de código que organiza ese grupo de operaciones como una sola unidad antes de guardarlas.

---

## Documentación de proyecto

### ADR (Architecture Decision Record)
Un archivo corto (una página) que documenta **una decisión de arquitectura importante**: qué se decidió, por qué, qué alternativas se consideraron, y qué se sacrificó. No es un manual — es una bitácora de "por qué el código es como es", para que en 6 meses (o un nuevo desarrollador) no tenga que adivinar. Ejemplo real que ya tienes: `docs/adr/0001-monolito-modular.md`, donde queda registrado por qué elegimos NestJS modular en vez de microservicios desde el día uno.

### OpenAPI / Swagger
**OpenAPI** es un estándar (un formato JSON/YAML) para describir qué endpoints tiene tu API, qué datos reciben y qué devuelven. **Swagger** es el conjunto de herramientas que lee ese estándar y genera una página web interactiva donde cualquiera puede ver y probar tus endpoints sin necesidad de leer el código. NestJS lo genera casi automático con decorators (`@ApiProperty()`, `@ApiOperation()`). Es la forma profesional de documentar una API — reemplaza tener que explicarle a cada desarrollador nuevo "qué le mandas a cada endpoint" por chat.

### RFC / PRD
**PRD** (Product Requirements Document) describe qué se va a construir y por qué, desde la perspectiva de negocio/producto (lo que ya armamos en nuestras conversaciones). **RFC** (Request For Comments) es similar pero más técnico — se usa cuando un desarrollador propone un cambio grande y quiere feedback del equipo antes de programarlo.

---

## Autenticación y UX

### Progressive Registration (registro progresivo)
En vez de forzar un registro completo (nombre, correo, contraseña) antes de dejar hacer nada, dejas que el usuario use la app de forma limitada como invitado, y solo le pides los datos mínimos necesarios **en el momento exacto en que se vuelven indispensables** (ej. al momento de pagar). Reduce la fricción y el abandono. Es el mismo patrón que usan apps como Uber Eats: navegas el menú sin cuenta, pero para pagar sí te registras.

### JWT (JSON Web Token)
Un "carnet digital" firmado que un servidor le entrega a un cliente después de autenticarse, y que el cliente reenvía en cada petición para probar quién es, sin que el servidor tenga que buscar en una base de datos cada vez. Se compone de: encabezado, datos (payload) y firma. El **Access Token** es de corta duración (15 min) por seguridad; el **Refresh Token** vive más tiempo y sirve para pedir un access token nuevo sin que el usuario tenga que volver a loguearse.

### OTP (One-Time Password)
Un código de un solo uso, normalmente de 6 dígitos, enviado por SMS o similar, para verificar que una persona realmente controla ese número de teléfono. Se usa en el registro progresivo para confirmar identidad sin pedir contraseña.

---

## Ingeniería de software / proceso

### Backlog
Lista completa de todo el trabajo pendiente de un producto, organizada en Épicas → Historias de usuario → Tareas.

### Sprint
Un bloque de tiempo fijo (1–2 semanas) donde el equipo se compromete a completar un subconjunto del backlog.

### CI/CD (Continuous Integration / Continuous Deployment)
**CI**: cada vez que subes código, un sistema automático (en nuestro caso, GitHub Actions) corre pruebas y revisa que nada se rompió, antes de permitir que se junte con el código de los demás. **CD**: ese mismo proceso, extendido, para desplegar automáticamente a producción cuando todo pasa.

### Conventional Commits
Una convención para escribir mensajes de commit de forma estandarizada (`feat:`, `fix:`, `docs:`, `refactor:`) que permite generar changelogs automáticos y entender el historial del proyecto de un vistazo.

### Trunk-Based Development
Una forma de trabajar con Git donde las ramas de features viven poco tiempo y se integran rápido a la rama principal, evitando ramas gigantes que se vuelven un dolor de cabeza al fusionar. Es más simple que GitFlow y se adapta mejor a equipos pequeños.
