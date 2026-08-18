// apps/api/src/seed/seed.ts
//
// Datos semilla para desarrollo y pruebas.
//
// Se ejecuta con:  pnpm --filter api run seed
//
// ES IDEMPOTENTE: podés correrlo cuantas veces quieras. Si un registro
// ya existe, lo reutiliza en vez de duplicarlo. Eso importa porque un
// seed que solo funciona contra una base vacía te obliga a borrar todo
// cada vez que querés agregar un dato nuevo.
//
// Crea DOS locales completamente independientes a propósito: es la única
// forma de probar que el aislamiento entre negocios funciona de verdad.
// Un solo venue nunca te demuestra que el Bar A no puede tocar al Bar B.

import { NestFactory } from '@nestjs/core';
import { DataSource, Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import type Redis from 'ioredis';

import { AppModule } from '../app.module';
import { REDIS_CLIENT } from '../redis/redis.module';
import { User } from '../modules/auth/entities/user.entity';
import { UserVenueRole } from '../modules/auth/entities/user-venue-role.entity';
import { Venue } from '../modules/venues/entities/venue.entity';
import { VenueTable } from '../modules/venues/entities/venue-table.entity';

// Clave única para todas las cuentas de prueba. Solo desarrollo.
const CLAVE_DEV = 'Rolita2026!';

// Ids del catálogo de roles, en el orden de privilegio del schema.
const ROL = {
  SUPER_ADMIN: 1,
  VENUE_ADMIN: 2,
  DJ: 3,
  STAFF: 4,
  CUSTOMER: 5,
} as const;

async function main(): Promise<void> {
  // Guard Clause: este script crea cuentas con contraseña conocida.
  // Correrlo en producción sería abrirle la puerta a cualquiera.
  if (process.env.NODE_ENV === 'production') {
    console.error('El seed NUNCA debe correr en producción. Abortando.');
    process.exit(1);
  }

  // createApplicationContext levanta Nest SIN servidor HTTP: solo el
  // contenedor de dependencias. Así reusamos la configuración de base
  // de datos que ya existe, en vez de duplicar la cadena de conexión.
  //
  // logger: false apaga el ruido de arranque de Nest. Usamos console.log
  // para nuestra salida: el Logger de Nest respeta los niveles globales,
  // así que filtrar niveles aquí silenciaría también nuestros mensajes.
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });

  const dataSource = app.get(DataSource);
  const usuarios = dataSource.getRepository(User);
  const venues = dataSource.getRepository(Venue);
  const mesas = dataSource.getRepository(VenueTable);
  const asignaciones = dataSource.getRepository(UserVenueRole);

  try {
    // ----------------------------------------------------------------
    // 1. Catálogo de roles
    // ----------------------------------------------------------------
    // Esto NO son datos de prueba: es data de catálogo que toda
    // instalación necesita, incluida producción. Su lugar natural es
    // schema.sql. Lo repetimos aquí de forma defensiva porque schema.sql
    // solo corre cuando el volumen de Docker está vacío.
    await dataSource.query(`
      INSERT INTO roles (id, name) VALUES
        (1, 'super_admin'),
        (2, 'venue_admin'),
        (3, 'dj'),
        (4, 'staff'),
        (5, 'customer')
      ON CONFLICT (id) DO NOTHING
    `);

    // Insertar ids explícitos en una columna SERIAL no adelanta el
    // contador de la secuencia. Sin este setval, el próximo INSERT sin
    // id intentaría usar el 1 y chocaría con la llave primaria.
    await dataSource.query(
      `SELECT setval('roles_id_seq', (SELECT MAX(id) FROM roles))`,
    );
    console.log('Catálogo de roles listo');

    // ----------------------------------------------------------------
    // 2. Locales — dos, independientes
    // ----------------------------------------------------------------
    const bar = await obtenerOCrearVenue(venues, {
      name: 'Bar La Rolita',
      type: 'bar',
      cooldownHours: 3,
      queueJumpPrice: 5,
      dedicationPrice: 3,
      comboJumpDedicationPrice: 7,
    });

    const gym = await obtenerOCrearVenue(venues, {
      name: 'Gimnasio Fuerza',
      type: 'gym',
      cooldownHours: 1,
      queueJumpPrice: 3,
      dedicationPrice: 2,
      comboJumpDedicationPrice: 4,
    });

    // ----------------------------------------------------------------
    // 3. Cuentas
    // ----------------------------------------------------------------
    // Cada local tiene personal PROPIO. No se comparten cuentas entre
    // negocios: si una persona trabaja en dos locales, son dos cuentas.
    const hash = await bcrypt.hash(CLAVE_DEV, 10);

    const superAdmin = await obtenerOCrearUsuario(usuarios, {
      email: 'super@unarolita.gt',
      displayName: 'Dueño de la plataforma',
      passwordHash: hash,
    });

    const adminBar = await obtenerOCrearUsuario(usuarios, {
      email: 'admin.bar@unarolita.gt',
      displayName: 'Admin del Bar',
      passwordHash: hash,
    });

    const djBar = await obtenerOCrearUsuario(usuarios, {
      email: 'dj.bar@unarolita.gt',
      displayName: 'DJ del Bar',
      passwordHash: hash,
    });

    const staffBar = await obtenerOCrearUsuario(usuarios, {
      email: 'staff.bar@unarolita.gt',
      displayName: 'Mesero del Bar',
      passwordHash: hash,
    });

    const adminGym = await obtenerOCrearUsuario(usuarios, {
      email: 'admin.gym@unarolita.gt',
      displayName: 'Admin del Gimnasio',
      passwordHash: hash,
    });

    // Cliente: sin contraseña. Los clientes entran por OTP, nunca por
    // el login de staff — por eso passwordHash queda null.
    const cliente = await obtenerOCrearUsuario(usuarios, {
      email: 'cliente@ejemplo.com',
      displayName: 'Cliente de prueba',
      passwordHash: null,
    });

    // ----------------------------------------------------------------
    // 4. Asignación de roles por local
    // ----------------------------------------------------------------
    // El super_admin lleva una fila nominal en el Bar. Es un parche:
    // loginStaff exige al menos una asignación para emitir token, y el
    // dueño de la plataforma no pertenece a ningún local. Una vez
    // emitido el token, VenueRolesGuard lo deja pasar en TODOS los
    // venues por su rol, así que una sola fila alcanza.
    // Ver hallazgo anotado en el backlog.
    await asignar(asignaciones, superAdmin.id, bar.id, ROL.SUPER_ADMIN);

    await asignar(asignaciones, adminBar.id, bar.id, ROL.VENUE_ADMIN);
    await asignar(asignaciones, djBar.id, bar.id, ROL.DJ);
    await asignar(asignaciones, staffBar.id, bar.id, ROL.STAFF);

    await asignar(asignaciones, adminGym.id, gym.id, ROL.VENUE_ADMIN);

    // El cliente NO recibe fila en user_venue_roles: 'customer' es un rol
    // implícito. Por eso los endpoints de cliente llevan solo
    // JwtAuthGuard — con VenueRolesGuard quedarían todos afuera.

    // ----------------------------------------------------------------
    // 5. Mesas
    // ----------------------------------------------------------------
    const mesa1Bar = await obtenerOCrearMesa(mesas, bar.id, 'Mesa 1');
    const mesa2Bar = await obtenerOCrearMesa(mesas, bar.id, 'Mesa 2');
    const estacionGym = await obtenerOCrearMesa(mesas, gym.id, 'Estación 1');

    // ----------------------------------------------------------------
    // Resumen
    // ----------------------------------------------------------------
    console.log('');
    console.log('════════════ DATOS SEMILLA LISTOS ════════════');
    console.log(`Clave para todas las cuentas con contraseña: ${CLAVE_DEV}`);
    console.log('');
    console.log(`Bar La Rolita     ${bar.id}`);
    console.log(`  super@unarolita.gt        super_admin`);
    console.log(`  admin.bar@unarolita.gt    venue_admin`);
    console.log(`  dj.bar@unarolita.gt       dj`);
    console.log(`  staff.bar@unarolita.gt    staff`);
    console.log(`  Mesa 1  QR: ${mesa1Bar.qrCodeToken}`);
    console.log(`  Mesa 2  QR: ${mesa2Bar.qrCodeToken}`);
    console.log('');
    console.log(`Gimnasio Fuerza   ${gym.id}`);
    console.log(`  admin.gym@unarolita.gt    venue_admin`);
    console.log(`  Estación 1  QR: ${estacionGym.qrCodeToken}`);
    console.log('');
    console.log(`Cliente (OTP, sin clave)    ${cliente.email}`);
    console.log('══════════════════════════════════════════════');
  } finally {
    // Cerrar SIEMPRE, aunque algo falle.
    //
    // OJO con Redis: RedisModule crea el cliente con useFactory y NO
    // implementa onModuleDestroy, así que app.close() no lo desconecta.
    // Esa conexión abierta mantiene vivo el bucle de eventos de Node y
    // el proceso nunca termina. Por eso lo cerramos a mano aquí.
    // (Anotado en el backlog: el módulo debería hacerlo solo.)
    const redis = app.get<Redis>(REDIS_CLIENT);
    await redis.quit();
    await app.close();
  }
}

// ------------------------------------------------------------------
// Helpers idempotentes. Cada uno busca primero y crea solo si falta.
// ------------------------------------------------------------------

async function obtenerOCrearVenue(
  repo: Repository<Venue>,
  datos: Partial<Venue> & { name: string },
): Promise<Venue> {
  const existente = await repo.findOne({ where: { name: datos.name } });
  if (existente) {
    return existente;
  }
  return repo.save(repo.create(datos));
}

async function obtenerOCrearUsuario(
  repo: Repository<User>,
  datos: { email: string; displayName: string; passwordHash: string | null },
): Promise<User> {
  const existente = await repo.findOne({ where: { email: datos.email } });
  if (existente) {
    return existente;
  }
  return repo.save(
    repo.create({
      email: datos.email,
      displayName: datos.displayName,
      passwordHash: datos.passwordHash,
      isEmailVerified: true, // en dev damos el correo por verificado
    }),
  );
}

async function obtenerOCrearMesa(
  repo: Repository<VenueTable>,
  venueId: string,
  label: string,
): Promise<VenueTable> {
  const existente = await repo.findOne({ where: { venueId, label } });
  if (existente) {
    return existente;
  }
  return repo.save(
    repo.create({
      venueId,
      label,
      // Mismo generador que usa VenuesService.createTable: un UUID v4.
      // 122 bits de aleatoriedad — imposible de adivinar por fuerza bruta.
      qrCodeToken: randomUUID(),
    }),
  );
}

async function asignar(
  repo: Repository<UserVenueRole>,
  userId: string,
  venueId: string,
  roleId: number,
): Promise<void> {
  const existente = await repo.findOne({ where: { userId, venueId, roleId } });
  if (existente) {
    return;
  }
  await repo.save(repo.create({ userId, venueId, roleId }));
}

main()
  .then(() => {
    // Salida explícita: si algo quedó abierto (un socket, un temporizador),
    // el proceso se colgaría en vez de terminar. En un script de una sola
    // pasada preferimos terminar de forma determinista.
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error('El seed falló:', error);
    process.exit(1);
  });
