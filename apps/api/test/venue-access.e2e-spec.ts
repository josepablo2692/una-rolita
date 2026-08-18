// apps/api/test/venue-access.e2e-spec.ts
//
// Convierte en pruebas automáticas la evidencia manual de la Fase 0
// (blindaje P0). Aquellos seis `curl` demostraban que el sistema estaba
// seguro ESE día, en ESA máquina, porque alguien los corrió. Esto lo
// demuestra en cada PR, para siempre, sin que nadie se acuerde.
//
// Crea sus PROPIOS datos con un sufijo único por corrida: no depende del
// seed y no choca consigo mismo si se corre dos veces seguidas.

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcryptjs';

import { AppModule } from '../src/app.module';
import { setupApp } from '../src/common/setup-app';
import { REDIS_CLIENT } from '../src/redis/redis.module';
import { User } from '../src/modules/auth/entities/user.entity';
import { UserVenueRole } from '../src/modules/auth/entities/user-venue-role.entity';
import { Venue } from '../src/modules/venues/entities/venue.entity';
import { VenueTable } from '../src/modules/venues/entities/venue-table.entity';

const CLAVE = 'Prueba2026!';
const ROL_SUPER_ADMIN = 1;
const ROL_VENUE_ADMIN = 2;

describe('Aislamiento entre locales (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  let venueA: Venue; // el local del admin
  let venueB: Venue; // el local AJENO
  let tokenAdminA: string;
  let tokenSuper: string;

  const sufijo = Date.now();
  const correoAdminA = `admin.a.${sufijo}@prueba.gt`;
  const correoSuper = `super.${sufijo}@prueba.gt`;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    setupApp(app); // ← la misma configuración que corre en producción
    await app.init();

    dataSource = app.get(DataSource);

    const venues = dataSource.getRepository(Venue);
    const users = dataSource.getRepository(User);
    const asignaciones = dataSource.getRepository(UserVenueRole);

    venueA = await venues.save(
      venues.create({ name: `Bar Prueba ${sufijo}`, type: 'bar' }),
    );
    venueB = await venues.save(
      venues.create({ name: `Gym Prueba ${sufijo}`, type: 'gym' }),
    );

    const hash = bcrypt.hashSync(CLAVE, 10);

    const adminA = await users.save(
      users.create({
        email: correoAdminA,
        displayName: 'Admin del local A',
        passwordHash: hash,
        isEmailVerified: true,
      }),
    );

    const superAdmin = await users.save(
      users.create({
        email: correoSuper,
        displayName: 'Dueño de plataforma',
        passwordHash: hash,
        isEmailVerified: true,
      }),
    );

    // El admin pertenece SOLO al local A. Nunca al B: ahí está la prueba.
    await asignaciones.save(
      asignaciones.create({
        userId: adminA.id,
        venueId: venueA.id,
        roleId: ROL_VENUE_ADMIN,
      }),
    );

    // El super_admin lleva una fila nominal porque loginStaff la exige.
    await asignaciones.save(
      asignaciones.create({
        userId: superAdmin.id,
        venueId: venueA.id,
        roleId: ROL_SUPER_ADMIN,
      }),
    );

    const r1 = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: correoAdminA, password: CLAVE })
      .expect(201);
    tokenAdminA = r1.body.accessToken;

    const r2 = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: correoSuper, password: CLAVE })
      .expect(201);
    tokenSuper = r2.body.accessToken;
  }, 30000);

  afterAll(async () => {
    // Limpieza en orden inverso a las dependencias: primero lo que
    // apunta, después lo apuntado.
    const venues = dataSource.getRepository(Venue);
    const users = dataSource.getRepository(User);
    const asignaciones = dataSource.getRepository(UserVenueRole);
    const mesas = dataSource.getRepository(VenueTable);

    await asignaciones.delete({ venueId: venueA.id });
    await asignaciones.delete({ venueId: venueB.id });
    await mesas.delete({ venueId: venueA.id });
    await mesas.delete({ venueId: venueB.id });
    await users.delete({ email: correoAdminA });
    await users.delete({ email: correoSuper });
    await venues.delete({ id: venueA.id });
    await venues.delete({ id: venueB.id });

    // Redis lo creamos con `new Redis(...)`, así que Nest no sabe cerrarlo.
    const redis: Redis = app.get(REDIS_CLIENT);
    await redis.quit();
    await app.close();
  }, 30000);

  // --------------------------------------------------------------
  // P0-2 — autorización con alcance de venue
  // --------------------------------------------------------------

  it('sin token no deja tocar precios (401)', () => {
    return request(app.getHttpServer())
      .patch(`/venues/${venueA.id}/pricing`)
      .send({ queueJumpPrice: 9 })
      .expect(401);
  });

  it('el admin SÍ puede cambiar los precios de SU local (200)', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/venues/${venueA.id}/pricing`)
      .set('Authorization', `Bearer ${tokenAdminA}`)
      .send({ queueJumpPrice: 9 })
      .expect(200);

    expect(res.body.queueJumpPrice).toBe(9);
  });

  it('el admin NO puede cambiar los precios de un local ajeno (403)', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/venues/${venueB.id}/pricing`)
      .set('Authorization', `Bearer ${tokenAdminA}`)
      .send({ queueJumpPrice: 1 })
      .expect(403);

    expect(res.body.message).toContain('No tienes acceso a este negocio');
  });

  it('el admin NO puede crear mesas en un local ajeno (403)', () => {
    return request(app.getHttpServer())
      .post(`/venues/${venueB.id}/tables`)
      .set('Authorization', `Bearer ${tokenAdminA}`)
      .send({ label: 'Mesa Pirata' })
      .expect(403);
  });

  it('el super_admin SÍ puede tocar cualquier local (200)', () => {
    return request(app.getHttpServer())
      .patch(`/venues/${venueB.id}/pricing`)
      .set('Authorization', `Bearer ${tokenSuper}`)
      .send({ queueJumpPrice: 4 })
      .expect(200);
  });

  // --------------------------------------------------------------
  // P0-1 y P0-5 — validación y precios enteros
  // --------------------------------------------------------------

  it('rechaza precios con centavos (400)', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/venues/${venueA.id}/pricing`)
      .set('Authorization', `Bearer ${tokenAdminA}`)
      .send({ queueJumpPrice: 4.5 })
      .expect(400);

    expect(res.body.message.join(' ')).toContain('entero');
  });

  it('rechaza campos no declarados en el DTO (400) — mass assignment', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: correoAdminA, password: CLAVE, isAdmin: true })
      .expect(400);

    expect(res.body.message.join(' ')).toContain('isAdmin');
  });

  // --------------------------------------------------------------
  // P0-5 — sin fugas en la respuesta pública
  // --------------------------------------------------------------

  it('GET /venues/:id no expone datos bancarios', async () => {
    const res = await request(app.getHttpServer())
      .get(`/venues/${venueA.id}`)
      .set('Authorization', `Bearer ${tokenAdminA}`)
      .expect(200);

    expect(res.body).not.toHaveProperty('bankAccountInfo');
    expect(res.body).not.toHaveProperty('spotifyAccountId');
  });
});
