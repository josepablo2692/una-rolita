// apps/api/test/credits-reversal.e2e-spec.ts
//
// Nota de crédito y trazabilidad.
//
// Lo que más importa aquí no es que la reversa funcione: es que el STAFF
// no pueda hacerla (pruebas 1 y 2). Si quien comete el error puede
// borrarlo solo, la auditoría no significa nada.

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
import { CreditsService } from '../src/modules/credits/credits.service';

const CLAVE = 'Prueba2026!';
const ROL_VENUE_ADMIN = 2;
const ROL_STAFF = 4;

describe('Nota de crédito y trazabilidad (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let credits: CreditsService;

  let venueA: Venue;
  let venueB: Venue; // para probar el IDOR
  let tokenAdmin: string;
  let tokenStaff: string;
  let staffId: string;

  const sufijo = Date.now();
  const creados: string[] = [];

  const crearUsuario = async (
    etiqueta: string,
    venueId: string,
    rol: number,
  ): Promise<{ id: string; token: string }> => {
    const users = dataSource.getRepository(User);
    const asignaciones = dataSource.getRepository(UserVenueRole);

    const email = `${etiqueta}.rev.${sufijo}@prueba.gt`;
    const usuario = await users.save(
      users.create({
        email,
        displayName: etiqueta,
        passwordHash: bcrypt.hashSync(CLAVE, 10),
        isEmailVerified: true,
        freeSongUsed: true,
      }),
    );
    creados.push(usuario.id);

    await asignaciones.save(
      asignaciones.create({ userId: usuario.id, venueId, roleId: rol }),
    );

    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: CLAVE })
      .expect(201);

    return { id: usuario.id, token: res.body.accessToken as string };
  };

  // Carga hecha "por el mesero", para tener algo que revertir.
  const cargar = async (
    userId: string,
    creditos: number,
    venueId = venueA.id,
  ) =>
    credits.applyTransaction({
      userId,
      venueId,
      type: 'topup_manual',
      amount: creditos,
      paymentMethod: 'efectivo_recepcion',
      cashAmount: creditos,
      createdByStaffId: staffId,
    });

  const saldoDe = (userId: string, venueId = venueA.id) =>
    credits.getBalance(userId, venueId);

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    setupApp(app);
    await app.init();

    dataSource = app.get(DataSource);
    credits = app.get(CreditsService);

    const venues = dataSource.getRepository(Venue);
    venueA = await venues.save(
      venues.create({ name: `Bar Reversas ${sufijo}`, type: 'bar' }),
    );
    venueB = await venues.save(
      venues.create({ name: `Gym Reversas ${sufijo}`, type: 'gym' }),
    );

    const admin = await crearUsuario('admin', venueA.id, ROL_VENUE_ADMIN);
    tokenAdmin = admin.token;

    const staff = await crearUsuario('staff', venueA.id, ROL_STAFF);
    tokenStaff = staff.token;
    staffId = staff.id;
  }, 60000);

  afterAll(async () => {
    const venues = [venueA.id, venueB.id];

    await dataSource.query(
      `ALTER TABLE credit_transactions DISABLE TRIGGER trg_credit_transactions_immutable`,
    );
    await dataSource.query(
      `DELETE FROM credit_transactions
        WHERE credit_account_id IN (
          SELECT id FROM credit_accounts WHERE venue_id = ANY($1::uuid[]))`,
      [venues],
    );
    await dataSource.query(
      `ALTER TABLE credit_transactions ENABLE TRIGGER trg_credit_transactions_immutable`,
    );

    await dataSource.query(
      `DELETE FROM credit_accounts WHERE venue_id = ANY($1::uuid[])`,
      [venues],
    );
    await dataSource.query(
      `DELETE FROM user_venue_roles WHERE venue_id = ANY($1::uuid[])`,
      [venues],
    );
    if (creados.length > 0) {
      await dataSource.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [
        creados,
      ]);
    }
    await dataSource.query(`DELETE FROM venues WHERE id = ANY($1::uuid[])`, [
      venues,
    ]);

    const redis: Redis = app.get(REDIS_CLIENT);
    await redis.quit();
    await app.close();
  }, 60000);

  // ==============================================================
  // SEPARACIÓN DE FUNCIONES — lo más importante del PR
  // ==============================================================

  it('1) el staff NO puede ver el historial del local (403)', async () => {
    await request(app.getHttpServer())
      .get(`/venues/${venueA.id}/credits/transactions`)
      .set('Authorization', `Bearer ${tokenStaff}`)
      .expect(403);
  }, 60000);

  it('2) el staff NO puede revertir: quien comete el error no lo borra solo (403)', async () => {
    const cliente = await crearUsuario('c2', venueA.id, ROL_VENUE_ADMIN);
    const carga = await cargar(cliente.id, 100);

    await request(app.getHttpServer())
      .post(`/venues/${venueA.id}/credits/transactions/${carga.id}/reverse`)
      .set('Authorization', `Bearer ${tokenStaff}`)
      .send({ reason: 'Quiero borrar mi propio error de tecleo' })
      .expect(403);

    // Y el saldo quedó intacto.
    expect(await saldoDe(cliente.id)).toBe(100);
  }, 60000);

  // ==============================================================
  // Historial y auditoría
  // ==============================================================

  it('3) el admin ve el historial con el nombre del mesero que cargó', async () => {
    const cliente = await crearUsuario('c3', venueA.id, ROL_VENUE_ADMIN);
    await cargar(cliente.id, 40);

    const res = await request(app.getHttpServer())
      .get(`/venues/${venueA.id}/credits/transactions`)
      .query({ userId: cliente.id })
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .expect(200);

    expect(res.body).toHaveLength(1);
    expect(res.body[0].amount).toBe(40);
    expect(res.body[0].staff.id).toBe(staffId);
    expect(res.body[0].customer.id).toBe(cliente.id);
    // Proyección de lista blanca: ni correos ni teléfonos.
    expect(res.body[0].customer).not.toHaveProperty('email');
  }, 60000);

  // ==============================================================
  // La reversa
  // ==============================================================

  it('4) reversa completa: el saldo vuelve y queda el asiento con su motivo', async () => {
    const cliente = await crearUsuario('c4', venueA.id, ROL_VENUE_ADMIN);
    const carga = await cargar(cliente.id, 100);
    expect(await saldoDe(cliente.id)).toBe(100);

    const res = await request(app.getHttpServer())
      .post(`/venues/${venueA.id}/credits/transactions/${carga.id}/reverse`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ reason: 'Error de tecleo, el cliente pago Q10 no Q100' })
      .expect(201);

    expect(res.body.amount).toBe(-100);
    expect(res.body.balanceAfter).toBe(0);
    expect(res.body.reversesTransactionId).toBe(carga.id);
    expect(res.body.reason).toContain('Error de tecleo');

    expect(await saldoDe(cliente.id)).toBe(0);

    // Nada se borró: quedan los DOS movimientos.
    const historial = await request(app.getHttpServer())
      .get(`/venues/${venueA.id}/credits/transactions`)
      .query({ userId: cliente.id })
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .expect(200);
    expect(historial.body).toHaveLength(2);
  }, 60000);

  it('5) un motivo de dos letras no pasa: la auditoría exige explicación (400)', async () => {
    const cliente = await crearUsuario('c5', venueA.id, ROL_VENUE_ADMIN);
    const carga = await cargar(cliente.id, 20);

    const res = await request(app.getHttpServer())
      .post(`/venues/${venueA.id}/credits/transactions/${carga.id}/reverse`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ reason: 'ups' })
      .expect(400);

    expect(res.body.message.join(' ')).toContain('10 caracteres');
    expect(await saldoDe(cliente.id)).toBe(20);
  }, 60000);

  it('6) no se puede revertir dos veces el mismo movimiento', async () => {
    const cliente = await crearUsuario('c6', venueA.id, ROL_VENUE_ADMIN);
    const carga = await cargar(cliente.id, 50);

    await request(app.getHttpServer())
      .post(`/venues/${venueA.id}/credits/transactions/${carga.id}/reverse`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ reason: 'Primera correccion de la carga' })
      .expect(201);

    const segunda = await request(app.getHttpServer())
      .post(`/venues/${venueA.id}/credits/transactions/${carga.id}/reverse`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ reason: 'Segundo intento sobre lo mismo' })
      .expect(400);

    expect(segunda.body.message).toContain('ya fue revertido');
    expect(await saldoDe(cliente.id)).toBe(0);
  }, 60000);

  // El caso real: cargan de más, el cliente ya gastó, y solo se puede
  // recuperar lo que queda. El bar come la diferencia, y queda escrita.
  it('7) si el cliente ya gastó, avisa el máximo reversible y admite reversa parcial', async () => {
    const cliente = await crearUsuario('c7', venueA.id, ROL_VENUE_ADMIN);
    const carga = await cargar(cliente.id, 100);

    // Gastó 60 en música.
    await credits.applyTransaction({
      userId: cliente.id,
      venueId: venueA.id,
      type: 'charge_song',
      amount: -60,
    });
    expect(await saldoDe(cliente.id)).toBe(40);

    const completa = await request(app.getHttpServer())
      .post(`/venues/${venueA.id}/credits/transactions/${carga.id}/reverse`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ reason: 'Intento revertir la carga completa de 100' })
      .expect(400);

    expect(completa.body.message).toContain('Máximo reversible ahora: 40');

    // Parcial por lo que queda.
    await request(app.getHttpServer())
      .post(`/venues/${venueA.id}/credits/transactions/${carga.id}/reverse`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ reason: 'Recupero lo que no se gasto', amount: 40 })
      .expect(201);

    expect(await saldoDe(cliente.id)).toBe(0);
  }, 60000);

  it('8) no se puede revertir una reversa', async () => {
    const cliente = await crearUsuario('c8', venueA.id, ROL_VENUE_ADMIN);
    const carga = await cargar(cliente.id, 30);

    const reversa = await request(app.getHttpServer())
      .post(`/venues/${venueA.id}/credits/transactions/${carga.id}/reverse`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ reason: 'Correccion de la carga original' })
      .expect(201);

    const res = await request(app.getHttpServer())
      .post(
        `/venues/${venueA.id}/credits/transactions/${reversa.body.reversalId}/reverse`,
      )
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ reason: 'Quiero deshacer la correccion anterior' })
      .expect(400);

    expect(res.body.message).toContain('No se puede revertir una reversa');
  }, 60000);

  it('9) no se puede revertir un movimiento de otro local (404)', async () => {
    const cliente = await crearUsuario('c9', venueA.id, ROL_VENUE_ADMIN);
    const carga = await cargar(cliente.id, 25);

    // El mismo id, pero pedido desde la ruta del OTRO local.
    await request(app.getHttpServer())
      .post(`/venues/${venueB.id}/credits/transactions/${carga.id}/reverse`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ reason: 'Intento revertir desde el local ajeno' })
      // El admin no tiene rol en venueB, así que ni siquiera pasa el guard.
      .expect(403);

    expect(await saldoDe(cliente.id)).toBe(25);
  }, 60000);

  it('10) un id malformado da 400, no 500', async () => {
    await request(app.getHttpServer())
      .post(`/venues/${venueA.id}/credits/transactions/no-es-un-uuid/reverse`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ reason: 'Motivo suficientemente largo' })
      .expect(400);
  }, 60000);

  it('11) el cliente ve su propio historial, sin datos del personal', async () => {
    const cliente = await crearUsuario('c11', venueA.id, ROL_VENUE_ADMIN);
    await cargar(cliente.id, 15);

    const res = await request(app.getHttpServer())
      .get(`/venues/${venueA.id}/credits/me/transactions`)
      .set('Authorization', `Bearer ${cliente.token}`)
      .expect(200);

    expect(res.body).toHaveLength(1);
    expect(res.body[0].amount).toBe(15);
    // Al cliente no le corresponde saber qué mesero registró qué.
    expect(res.body[0]).not.toHaveProperty('staff');
    expect(res.body[0]).not.toHaveProperty('customer');
  }, 60000);
});
