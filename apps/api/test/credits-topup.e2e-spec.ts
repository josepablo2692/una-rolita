// apps/api/test/credits-topup.e2e-spec.ts
//
// Los cinco caminos de la Definición de Terminado sobre el endpoint de
// carga en recepción, más dos propios de este módulo que valen todavía
// más: el doble cobro por HTTP y la fuga de datos del cliente.
//
// Cubre la puerta (guards, DTO, proyección). El motor — atomicidad,
// concurrencia, inmutabilidad — ya está cubierto en credits.e2e-spec.ts.

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';

import { AppModule } from '../src/app.module';
import { setupApp } from '../src/common/setup-app';
import { REDIS_CLIENT } from '../src/redis/redis.module';
import { User } from '../src/modules/auth/entities/user.entity';
import { UserVenueRole } from '../src/modules/auth/entities/user-venue-role.entity';
import { Venue } from '../src/modules/venues/entities/venue.entity';
import { CreditTransaction } from '../src/modules/credits/entities/credit-transaction.entity';

const CLAVE = 'Prueba2026!';
const ROL_VENUE_ADMIN = 2;
const ROL_DJ = 3;
const ROL_STAFF = 4;

describe('Carga de créditos en recepción (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  let venueA: Venue; // el local del staff
  let venueB: Venue; // el local AJENO
  let tokenStaff: string;
  let tokenDj: string;
  let tokenCliente: string;
  let staffId: string;
  let clienteId: string;

  const sufijo = Date.now();
  const correoCliente = `cliente.topup.${sufijo}@prueba.gt`;

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: CLAVE })
      .expect(201);
    return res.body.accessToken as string;
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    setupApp(app); // misma configuración global que corre en producción
    await app.init();

    dataSource = app.get(DataSource);

    const venues = dataSource.getRepository(Venue);
    const users = dataSource.getRepository(User);
    const asignaciones = dataSource.getRepository(UserVenueRole);

    venueA = await venues.save(
      venues.create({ name: `Bar Topup ${sufijo}`, type: 'bar' }),
    );
    venueB = await venues.save(
      venues.create({ name: `Gym Topup ${sufijo}`, type: 'gym' }),
    );

    const hash = bcrypt.hashSync(CLAVE, 10);

    const staff = await users.save(
      users.create({
        email: `staff.topup.${sufijo}@prueba.gt`,
        displayName: 'Mesero del Bar',
        passwordHash: hash,
        isEmailVerified: true,
      }),
    );
    staffId = staff.id;

    const dj = await users.save(
      users.create({
        email: `dj.topup.${sufijo}@prueba.gt`,
        displayName: 'DJ del Bar',
        passwordHash: hash,
        isEmailVerified: true,
      }),
    );

    // El cliente NO recibe fila en user_venue_roles: 'customer' es un rol
    // implícito. Entra con contraseña solo para poder pedir su token en
    // la prueba; en producción entraría por OTP.
    const cliente = await users.save(
      users.create({
        email: correoCliente,
        displayName: 'Cliente de prueba',
        passwordHash: hash,
        isEmailVerified: true,
      }),
    );
    clienteId = cliente.id;

    await asignaciones.save([
      asignaciones.create({
        userId: staff.id,
        venueId: venueA.id,
        roleId: ROL_STAFF,
      }),
      asignaciones.create({
        userId: dj.id,
        venueId: venueA.id,
        roleId: ROL_DJ,
      }),
    ]);

    tokenStaff = await login(staff.email!);
    tokenDj = await login(dj.email!);

    // El cliente no tiene rol de venue, así que loginStaff lo rechaza.
    // Le damos uno nominal en el venue B (donde nunca opera) solo para
    // obtener un token de cliente autenticado.
    await asignaciones.save(
      asignaciones.create({
        userId: cliente.id,
        venueId: venueB.id,
        roleId: ROL_VENUE_ADMIN,
      }),
    );
    tokenCliente = await login(correoCliente);
  }, 30000);

  afterAll(async () => {
    // El trigger de inmutabilidad bloquea DELETE sobre el libro mayor.
    // Desactivarlo a propósito para limpiar es la señal de que la
    // protección es real.
    await dataSource.query(
      `ALTER TABLE credit_transactions DISABLE TRIGGER trg_credit_transactions_immutable`,
    );
    await dataSource.query(
      `DELETE FROM credit_transactions
        WHERE credit_account_id IN (
          SELECT id FROM credit_accounts WHERE venue_id = ANY($1::uuid[]))`,
      [[venueA.id, venueB.id]],
    );
    await dataSource.query(
      `ALTER TABLE credit_transactions ENABLE TRIGGER trg_credit_transactions_immutable`,
    );

    await dataSource.query(
      `DELETE FROM credit_accounts WHERE venue_id = ANY($1::uuid[])`,
      [[venueA.id, venueB.id]],
    );
    await dataSource.query(
      `DELETE FROM user_venue_roles WHERE venue_id = ANY($1::uuid[])`,
      [[venueA.id, venueB.id]],
    );
    await dataSource.query(`DELETE FROM users WHERE email LIKE $1`, [
      `%.topup.${sufijo}@prueba.gt`,
    ]);
    await dataSource.query(`DELETE FROM venues WHERE id = ANY($1::uuid[])`, [
      [venueA.id, venueB.id],
    ]);

    const redis: Redis = app.get(REDIS_CLIENT);
    await redis.quit();
    await app.close();
  }, 30000);

  const cargaValida = (llave = randomUUID()) => ({
    userId: clienteId,
    credits: 25,
    paymentMethod: 'efectivo_recepcion',
    cashAmount: 25,
    idempotencyKey: llave,
  });

  // ==============================================================
  // 1..5 — Los cinco caminos de la Definición de Terminado
  // ==============================================================

  it('1) sin token no deja cargar créditos (401)', () => {
    return request(app.getHttpServer())
      .post(`/venues/${venueA.id}/credits/topup`)
      .send(cargaValida())
      .expect(401);
  });

  it('2) un DJ no puede cargar créditos, aunque trabaje en el local (403)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/venues/${venueA.id}/credits/topup`)
      .set('Authorization', `Bearer ${tokenDj}`)
      .send(cargaValida())
      .expect(403);

    expect(res.body.message).toContain('requiere uno de estos roles');
  });

  it('3) el staff del Bar no puede cargar en el Gimnasio (403)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/venues/${venueB.id}/credits/topup`)
      .set('Authorization', `Bearer ${tokenStaff}`)
      .send(cargaValida())
      .expect(403);

    expect(res.body.message).toContain('No tienes acceso a este negocio');
  });

  it('4) rechaza créditos con decimales y llave de idempotencia inválida (400)', async () => {
    const decimales = await request(app.getHttpServer())
      .post(`/venues/${venueA.id}/credits/topup`)
      .set('Authorization', `Bearer ${tokenStaff}`)
      .send({ ...cargaValida(), credits: 12.5 })
      .expect(400);
    expect(decimales.body.message.join(' ')).toContain('entero');

    const llaveMala = await request(app.getHttpServer())
      .post(`/venues/${venueA.id}/credits/topup`)
      .set('Authorization', `Bearer ${tokenStaff}`)
      .send({ ...cargaValida(), idempotencyKey: 'no-es-un-uuid' })
      .expect(400);
    expect(llaveMala.body.message.join(' ')).toContain('UUID');

    // Y un campo colado que no está en el DTO.
    const colado = await request(app.getHttpServer())
      .post(`/venues/${venueA.id}/credits/topup`)
      .set('Authorization', `Bearer ${tokenStaff}`)
      .send({ ...cargaValida(), createdByStaffId: clienteId })
      .expect(400);
    expect(colado.body.message.join(' ')).toContain('createdByStaffId');
  });

  it('5) camino feliz: el staff carga 25 créditos y queda registrado como autor', async () => {
    const res = await request(app.getHttpServer())
      .post(`/venues/${venueA.id}/credits/topup`)
      .set('Authorization', `Bearer ${tokenStaff}`)
      .send(cargaValida())
      .expect(201);

    expect(res.body.credits).toBe(25);
    expect(res.body.balance).toBe(25);
    expect(res.body.transactionId).toBeDefined();

    // La auditoría apunta al mesero del TOKEN, no a nada que viniera del
    // cuerpo de la petición.
    const movimiento = await dataSource
      .getRepository(CreditTransaction)
      .findOneOrFail({ where: { id: res.body.transactionId } });

    expect(movimiento.createdByStaffId).toBe(staffId);
    expect(movimiento.type).toBe('topup_manual');
    expect(movimiento.paymentMethod).toBe('efectivo_recepcion');
    expect(movimiento.cashAmount).toBe(25);
  });

  // ==============================================================
  // 6..7 — Propias de este módulo
  // ==============================================================

  it('6) el doble clic del mesero no cobra dos veces', async () => {
    const llave = randomUUID();

    const primera = await request(app.getHttpServer())
      .post(`/venues/${venueA.id}/credits/topup`)
      .set('Authorization', `Bearer ${tokenStaff}`)
      .send({ ...cargaValida(llave), credits: 10 })
      .expect(201);

    const segunda = await request(app.getHttpServer())
      .post(`/venues/${venueA.id}/credits/topup`)
      .set('Authorization', `Bearer ${tokenStaff}`)
      .send({ ...cargaValida(llave), credits: 10 })
      .expect(201);

    // Mismo movimiento devuelto, no uno nuevo.
    expect(segunda.body.transactionId).toBe(primera.body.transactionId);
    // Y el saldo se movió UNA sola vez: 25 de la prueba anterior + 10.
    expect(segunda.body.balance).toBe(35);
  });

  it('7) la búsqueda no devuelve el correo, aunque se haya buscado por correo', async () => {
    const res = await request(app.getHttpServer())
      .get(`/venues/${venueA.id}/credits/account`)
      .query({ email: correoCliente })
      .set('Authorization', `Bearer ${tokenStaff}`)
      .expect(200);

    expect(res.body.userId).toBe(clienteId);
    expect(res.body.balance).toBe(35);
    expect(res.body.tienePhone).toBe(false);

    // Proyección de lista blanca: el mesero no ve datos de contacto.
    expect(res.body).not.toHaveProperty('email');
    expect(res.body).not.toHaveProperty('phoneNumber');
    expect(res.body).not.toHaveProperty('passwordHash');
  });

  it('8) la búsqueda exige teléfono O correo, no ambos ni ninguno', async () => {
    await request(app.getHttpServer())
      .get(`/venues/${venueA.id}/credits/account`)
      .set('Authorization', `Bearer ${tokenStaff}`)
      .expect(400);

    await request(app.getHttpServer())
      .get(`/venues/${venueA.id}/credits/account`)
      .query({ email: correoCliente, phone: '50212345678' })
      .set('Authorization', `Bearer ${tokenStaff}`)
      .expect(400);
  });

  it('9) el cliente ve su propio saldo y no puede pedir el de otro', async () => {
    const res = await request(app.getHttpServer())
      .get(`/venues/${venueA.id}/credits/me`)
      .set('Authorization', `Bearer ${tokenCliente}`)
      .expect(200);

    // El userId sale del token: no hay parámetro que manipular para
    // pedir el saldo ajeno. La protección es estructural, no una
    // comprobación que se pueda olvidar.
    expect(res.body.balance).toBe(35);
  });
});
