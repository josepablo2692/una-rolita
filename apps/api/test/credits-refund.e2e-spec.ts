// apps/api/test/credits-refund.e2e-spec.ts
//
// Reembolsos y orden de la cola pagada (ADR 0007).
//
// La prueba 1 es la más importante: simula lo que encontramos en papel
// con una cola de 50 pedidos. Con el algoritmo anterior, cada salto nuevo
// se metía adelante de los anteriores, así que quien pagaba primero
// terminaba último. Esta prueba lo habría atrapado.

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
import { VenueTable } from '../src/modules/venues/entities/venue-table.entity';
import { QueueRequest } from '../src/modules/queue/entities/queue-request.entity';
import { CreditsService } from '../src/modules/credits/credits.service';

const CLAVE = 'Prueba2026!';
const ROL_VENUE_ADMIN = 2;
const ROL_DJ = 3;
const PRECIO_CANCION = 1;
const PRECIO_SALTO = 5;

describe('Reembolsos y orden de la cola pagada (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let credits: CreditsService;

  let venue: Venue;
  let mesa: VenueTable;
  let tokenDj: string;

  const sufijo = Date.now();
  const creados: string[] = [];

  const crearUsuario = async (opciones: {
    etiqueta: string;
    rol: number;
    correoVerificado?: boolean;
    yaUsoGratis?: boolean;
    creditos?: number;
  }): Promise<{ id: string; token: string }> => {
    const users = dataSource.getRepository(User);
    const asignaciones = dataSource.getRepository(UserVenueRole);

    const email = `${opciones.etiqueta}.reembolso.${sufijo}@prueba.gt`;
    const usuario = await users.save(
      users.create({
        email,
        displayName: opciones.etiqueta,
        passwordHash: bcrypt.hashSync(CLAVE, 10),
        isEmailVerified: opciones.correoVerificado ?? true,
        freeSongUsed: opciones.yaUsoGratis ?? true,
      }),
    );
    creados.push(usuario.id);

    await asignaciones.save(
      asignaciones.create({
        userId: usuario.id,
        venueId: venue.id,
        roleId: opciones.rol,
      }),
    );

    if (opciones.creditos) {
      await credits.applyTransaction({
        userId: usuario.id,
        venueId: venue.id,
        type: 'topup_manual',
        amount: opciones.creditos,
        paymentMethod: 'efectivo_recepcion',
      });
    }

    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: CLAVE })
      .expect(201);

    return { id: usuario.id, token: res.body.accessToken as string };
  };

  const pedir = async (token: string, isPaidJump = false): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post(`/venues/${venue.id}/queue`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        tableId: mesa.id,
        songProviderTrackId: randomUUID(),
        songTitle: 'Canción de prueba',
        songArtist: 'Artista de prueba',
        isPaidJump,
      })
      .expect(201);
    return res.body.id as string;
  };

  const posicionDe = async (requestId: string): Promise<number> => {
    const pedido = await dataSource
      .getRepository(QueueRequest)
      .findOneOrFail({ where: { id: requestId } });
    return pedido.position;
  };

  const saldoDe = (userId: string) => credits.getBalance(userId, venue.id);

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    setupApp(app);
    await app.init();

    dataSource = app.get(DataSource);
    credits = app.get(CreditsService);

    venue = await dataSource.getRepository(Venue).save(
      dataSource.getRepository(Venue).create({
        name: `Bar Reembolsos ${sufijo}`,
        type: 'bar',
        songPrice: PRECIO_CANCION,
        queueJumpPrice: PRECIO_SALTO,
      }),
    );

    mesa = await dataSource.getRepository(VenueTable).save(
      dataSource.getRepository(VenueTable).create({
        venueId: venue.id,
        label: 'Mesa 1',
        qrCodeToken: randomUUID(),
      }),
    );

    const dj = await crearUsuario({ etiqueta: 'dj', rol: ROL_DJ });
    tokenDj = dj.token;
  }, 60000);

  afterAll(async () => {
    await dataSource.query(
      `ALTER TABLE credit_transactions DISABLE TRIGGER trg_credit_transactions_immutable`,
    );
    await dataSource.query(
      `DELETE FROM credit_transactions
        WHERE credit_account_id IN (SELECT id FROM credit_accounts WHERE venue_id = $1)`,
      [venue.id],
    );
    await dataSource.query(
      `ALTER TABLE credit_transactions ENABLE TRIGGER trg_credit_transactions_immutable`,
    );

    await dataSource.query(`DELETE FROM queue_jumps WHERE venue_id = $1`, [
      venue.id,
    ]);
    await dataSource.query(`DELETE FROM queue_requests WHERE venue_id = $1`, [
      venue.id,
    ]);
    await dataSource.query(`DELETE FROM credit_accounts WHERE venue_id = $1`, [
      venue.id,
    ]);
    await dataSource.query(`DELETE FROM user_venue_roles WHERE venue_id = $1`, [
      venue.id,
    ]);
    await dataSource.query(`DELETE FROM tables WHERE venue_id = $1`, [
      venue.id,
    ]);
    if (creados.length > 0) {
      await dataSource.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [
        creados,
      ]);
    }
    await dataSource.query(`DELETE FROM venues WHERE id = $1`, [venue.id]);

    const redis: Redis = app.get(REDIS_CLIENT);
    await redis.quit();
    await app.close();
  }, 60000);

  // ==============================================================
  // LA PRUEBA DE REGRESIÓN DEL BUG
  //
  // María, Pedro y Ana pagan salto en ese orden. FIFO significa que María
  // queda ADELANTE. Con el código anterior quedaba ATRÁS de los dos, y
  // ese era el defecto que hacía injusta toda la política de reembolso.
  // ==============================================================
  it('1) tres saltos pagados en orden respetan FIFO: quien paga primero suena primero', async () => {
    // Cola normal previa, para que los saltos tengan a quién empujar.
    const normal1 = await crearUsuario({
      etiqueta: 'n1',
      rol: ROL_VENUE_ADMIN,
      creditos: 20,
    });
    const normal2 = await crearUsuario({
      etiqueta: 'n2',
      rol: ROL_VENUE_ADMIN,
      creditos: 20,
    });
    const pedidoNormal1 = await pedir(normal1.token);
    const pedidoNormal2 = await pedir(normal2.token);

    const maria = await crearUsuario({
      etiqueta: 'maria',
      rol: ROL_VENUE_ADMIN,
      creditos: 20,
    });
    const pedro = await crearUsuario({
      etiqueta: 'pedro',
      rol: ROL_VENUE_ADMIN,
      creditos: 20,
    });
    const ana = await crearUsuario({
      etiqueta: 'ana',
      rol: ROL_VENUE_ADMIN,
      creditos: 20,
    });

    const saltoMaria = await pedir(maria.token, true);
    const saltoPedro = await pedir(pedro.token, true);
    const saltoAna = await pedir(ana.token, true);

    const posMaria = await posicionDe(saltoMaria);
    const posPedro = await posicionDe(saltoPedro);
    const posAna = await posicionDe(saltoAna);

    // El orden de pago es el orden de la cola.
    expect(posMaria).toBeLessThan(posPedro);
    expect(posPedro).toBeLessThan(posAna);

    // Y los tres saltos van adelante de los pedidos normales.
    expect(posAna).toBeLessThan(await posicionDe(pedidoNormal1));
    expect(posAna).toBeLessThan(await posicionDe(pedidoNormal2));
  }, 60000);

  it('2) el artista salta un pedido pagado: se devuelve todo', async () => {
    const cliente = await crearUsuario({
      etiqueta: 'saltado',
      rol: ROL_VENUE_ADMIN,
      creditos: 20,
    });
    const pedido = await pedir(cliente.token, true);

    expect(await saldoDe(cliente.id)).toBe(20 - PRECIO_SALTO);

    await request(app.getHttpServer())
      .patch(`/venues/${venue.id}/queue/${pedido}/skip`)
      .set('Authorization', `Bearer ${tokenDj}`)
      .expect(200);

    // Vuelve completo: el local incumplió.
    expect(await saldoDe(cliente.id)).toBe(20);
  }, 60000);

  it('3) el cliente cancela un pedido con salto: NO se devuelve nada', async () => {
    const cliente = await crearUsuario({
      etiqueta: 'cancelasalto',
      rol: ROL_VENUE_ADMIN,
      creditos: 20,
    });
    const pedido = await pedir(cliente.token, true);

    await request(app.getHttpServer())
      .patch(`/venues/${venue.id}/queue/${pedido}/cancel`)
      .set('Authorization', `Bearer ${cliente.token}`)
      .expect(200);

    // Recibió la posición que compró y decidió retirarse.
    expect(await saldoDe(cliente.id)).toBe(20 - PRECIO_SALTO);
  }, 60000);

  it('4) el cliente cancela un pedido normal: se le devuelve lo que pagó', async () => {
    const cliente = await crearUsuario({
      etiqueta: 'cancelanormal',
      rol: ROL_VENUE_ADMIN,
      creditos: 20,
    });
    const pedido = await pedir(cliente.token);

    expect(await saldoDe(cliente.id)).toBe(20 - PRECIO_CANCION);

    await request(app.getHttpServer())
      .patch(`/venues/${venue.id}/queue/${pedido}/cancel`)
      .set('Authorization', `Bearer ${cliente.token}`)
      .expect(200);

    expect(await saldoDe(cliente.id)).toBe(20);
  }, 60000);

  it('5) si el artista salta una canción gratis, se restituye la promoción', async () => {
    const cliente = await crearUsuario({
      etiqueta: 'gratissaltada',
      rol: ROL_VENUE_ADMIN,
      yaUsoGratis: false,
      creditos: 0,
    });
    const pedido = await pedir(cliente.token);

    let usuario = await dataSource
      .getRepository(User)
      .findOneOrFail({ where: { id: cliente.id } });
    expect(usuario.freeSongUsed).toBe(true);

    await request(app.getHttpServer())
      .patch(`/venues/${venue.id}/queue/${pedido}/skip`)
      .set('Authorization', `Bearer ${tokenDj}`)
      .expect(200);

    // No hay crédito que devolver (el neto fue cero), pero perdió su
    // promoción sin recibir nada. El local incumplió: se le restituye.
    expect(await saldoDe(cliente.id)).toBe(0);
    usuario = await dataSource
      .getRepository(User)
      .findOneOrFail({ where: { id: cliente.id } });
    expect(usuario.freeSongUsed).toBe(false);
  }, 60000);

  it('6) si el cliente cancela su canción gratis, NO se restituye', async () => {
    const cliente = await crearUsuario({
      etiqueta: 'gratiscancelada',
      rol: ROL_VENUE_ADMIN,
      yaUsoGratis: false,
      creditos: 0,
    });
    const pedido = await pedir(cliente.token);

    await request(app.getHttpServer())
      .patch(`/venues/${venue.id}/queue/${pedido}/cancel`)
      .set('Authorization', `Bearer ${cliente.token}`)
      .expect(200);

    // La usó por decisión propia.
    const usuario = await dataSource
      .getRepository(User)
      .findOneOrFail({ where: { id: cliente.id } });
    expect(usuario.freeSongUsed).toBe(true);
  }, 60000);

  it('7) no se puede reembolsar dos veces el mismo pedido', async () => {
    const cliente = await crearUsuario({
      etiqueta: 'doble',
      rol: ROL_VENUE_ADMIN,
      creditos: 20,
    });
    const pedido = await pedir(cliente.token, true);

    await request(app.getHttpServer())
      .patch(`/venues/${venue.id}/queue/${pedido}/skip`)
      .set('Authorization', `Bearer ${tokenDj}`)
      .expect(200);
    expect(await saldoDe(cliente.id)).toBe(20);

    // El guard de estado es lo que protege la caja: ya no está en cola.
    await request(app.getHttpServer())
      .patch(`/venues/${venue.id}/queue/${pedido}/skip`)
      .set('Authorization', `Bearer ${tokenDj}`)
      .expect(400);

    expect(await saldoDe(cliente.id)).toBe(20);
  }, 60000);
});
