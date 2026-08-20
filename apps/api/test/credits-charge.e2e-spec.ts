// apps/api/test/credits-charge.e2e-spec.ts
//
// El cobro al pedir una canción: donde QueueModule y CreditsModule se
// tocan por primera vez. Lo que más importa aquí no es que cobre bien —
// es que cuando NO puede cobrar, tampoco encole (prueba 3).

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
import { CreditAccount } from '../src/modules/credits/entities/credit-account.entity';
import { CreditTransaction } from '../src/modules/credits/entities/credit-transaction.entity';

const CLAVE = 'Prueba2026!';
const ROL_VENUE_ADMIN = 2;
const PRECIO_CANCION = 1;
const PRECIO_SALTO = 5;

describe('Cobro al pedir canción (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let credits: CreditsService;

  let venue: Venue;
  let mesa: VenueTable;

  const sufijo = Date.now();
  const creados: string[] = [];

  // Crea un cliente y le da un rol nominal para poder pedir token con
  // loginStaff. En producción los clientes entran por OTP; aquí es solo
  // la forma de obtener un JWT. No afecta lo que se prueba: los endpoints
  // de la cola usan únicamente JwtAuthGuard, nunca VenueRolesGuard.
  const crearCliente = async (opciones: {
    etiqueta: string;
    correoVerificado: boolean;
    yaUsoGratis: boolean;
    creditos: number;
  }): Promise<{ id: string; token: string }> => {
    const users = dataSource.getRepository(User);
    const asignaciones = dataSource.getRepository(UserVenueRole);

    const email = `${opciones.etiqueta}.cobro.${sufijo}@prueba.gt`;
    const usuario = await users.save(
      users.create({
        email,
        displayName: opciones.etiqueta,
        passwordHash: bcrypt.hashSync(CLAVE, 10),
        isEmailVerified: opciones.correoVerificado,
        freeSongUsed: opciones.yaUsoGratis,
      }),
    );
    creados.push(usuario.id);

    await asignaciones.save(
      asignaciones.create({
        userId: usuario.id,
        venueId: venue.id,
        roleId: ROL_VENUE_ADMIN,
      }),
    );

    if (opciones.creditos > 0) {
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

  // Cada pedido usa una canción distinta para que el cooldown por venue
  // nunca interfiera con lo que estamos midiendo.
  const pedir = (token: string, isPaidJump = false) =>
    request(app.getHttpServer())
      .post(`/venues/${venue.id}/queue`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        tableId: mesa.id,
        songProviderTrackId: randomUUID(),
        songTitle: 'Canción de prueba',
        songArtist: 'Artista de prueba',
        isPaidJump,
      });

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

    const venues = dataSource.getRepository(Venue);
    venue = await venues.save(
      venues.create({
        name: `Bar Cobros ${sufijo}`,
        type: 'bar',
        songPrice: PRECIO_CANCION,
        queueJumpPrice: PRECIO_SALTO,
      }),
    );

    const mesas = dataSource.getRepository(VenueTable);
    mesa = await mesas.save(
      mesas.create({
        venueId: venue.id,
        label: 'Mesa 1',
        qrCodeToken: randomUUID(),
      }),
    );
  }, 30000);

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
  }, 30000);

  it('1) una canción sola cuesta 1 crédito', async () => {
    const cliente = await crearCliente({
      etiqueta: 'simple',
      correoVerificado: true,
      yaUsoGratis: true, // sin gratis, para medir el cobro puro
      creditos: 10,
    });

    await pedir(cliente.token).expect(201);

    expect(await saldoDe(cliente.id)).toBe(10 - PRECIO_CANCION);

    const cuenta = await dataSource
      .getRepository(CreditAccount)
      .findOneOrFail({ where: { userId: cliente.id, venueId: venue.id } });

    const cobros = await dataSource.getRepository(CreditTransaction).find({
      where: { creditAccountId: cuenta.id, type: 'charge_song' },
    });
    expect(cobros).toHaveLength(1);
    expect(cobros[0].amount).toBe(-PRECIO_CANCION);
    expect(cobros[0].queueRequestId).toBeTruthy();
  });

  // ESTA prueba protege el modelo de precios. Si alguien "arregla" el
  // código sumando la canción al salto, el saldo daría 4 y esto falla.
  it('2) el salto cuesta 5, NO 6: el precio ya incluye la canción', async () => {
    const cliente = await crearCliente({
      etiqueta: 'salto',
      correoVerificado: true,
      yaUsoGratis: true,
      creditos: 10,
    });

    await pedir(cliente.token, true).expect(201);

    expect(await saldoDe(cliente.id)).toBe(10 - PRECIO_SALTO);

    const cuenta = await dataSource
      .getRepository(CreditAccount)
      .findOneOrFail({ where: { userId: cliente.id, venueId: venue.id } });

    const cobros = await dataSource
      .getRepository(CreditTransaction)
      .find({ where: { creditAccountId: cuenta.id } });

    // UN solo renglón, no dos: un pedido = un producto.
    expect(cobros.filter((c) => c.type === 'charge_jump')).toHaveLength(1);
    expect(cobros.filter((c) => c.type === 'charge_song')).toHaveLength(0);
  });

  // LA MÁS IMPORTANTE: si no se puede cobrar, tampoco se encola.
  it('3) sin saldo suficiente: 400 y la canción NO entra a la cola', async () => {
    const cliente = await crearCliente({
      etiqueta: 'pobre',
      correoVerificado: true,
      yaUsoGratis: true,
      creditos: 2, // menos que el salto
    });

    const pedidosAntes = await dataSource
      .getRepository(QueueRequest)
      .count({ where: { venueId: venue.id } });

    const res = await pedir(cliente.token, true).expect(400);
    expect(res.body.message).toContain('No te alcanzan los créditos');

    // El saldo quedó intacto: la transacción hizo ROLLBACK completo.
    expect(await saldoDe(cliente.id)).toBe(2);

    // Y la cola también. Sin transacción, aquí habría un pedido huérfano.
    const pedidosDespues = await dataSource
      .getRepository(QueueRequest)
      .count({ where: { venueId: venue.id } });
    expect(pedidosDespues).toBe(pedidosAntes);
  });

  it('4) el primer pedido es gratis, aun con saldo 0', async () => {
    const cliente = await crearCliente({
      etiqueta: 'nuevo',
      correoVerificado: true,
      yaUsoGratis: false,
      creditos: 0,
    });

    await pedir(cliente.token).expect(201);

    // Suma cero: se regaló un crédito y se gastó en el mismo momento.
    expect(await saldoDe(cliente.id)).toBe(0);

    const cuenta = await dataSource
      .getRepository(CreditAccount)
      .findOneOrFail({ where: { userId: cliente.id, venueId: venue.id } });

    const movimientos = await dataSource.getRepository(CreditTransaction).find({
      where: { creditAccountId: cuenta.id },
      // Por `seq` y no por `createdAt`: los dos renglones se insertan
      // dentro del mismo milisegundo, así que sus timestamps empatan y el
      // orden sería aleatorio. La secuencia de la base nunca empata.
      order: { seq: 'ASC' },
    });

    // Dos renglones, no cero: la promoción queda ESCRITA. Si solo
    // omitiéramos el cobro, no habría forma de contar cuántas diste.
    expect(movimientos.map((m) => m.type)).toEqual([
      'grant_free_song',
      'charge_song',
    ]);

    const usuario = await dataSource
      .getRepository(User)
      .findOneOrFail({ where: { id: cliente.id } });
    expect(usuario.freeSongUsed).toBe(true);
  });

  it('5) la canción gratis es UNA sola vez', async () => {
    const cliente = await crearCliente({
      etiqueta: 'repetido',
      correoVerificado: true,
      yaUsoGratis: false,
      creditos: 5,
    });

    await pedir(cliente.token).expect(201);
    expect(await saldoDe(cliente.id)).toBe(5); // la primera fue gratis

    await pedir(cliente.token).expect(201);
    expect(await saldoDe(cliente.id)).toBe(4); // la segunda ya cuesta
  });

  it('6) la gratis NO cubre el salto, y no se pierde al intentarlo', async () => {
    const cliente = await crearCliente({
      etiqueta: 'saltogratis',
      correoVerificado: true,
      yaUsoGratis: false,
      creditos: 0,
    });

    // Con saldo 0 no puede pagar el salto: la gratis cubre el producto
    // "canción sola", no el de Q5.
    await pedir(cliente.token, true).expect(400);

    // Y conserva su canción gratis para después.
    const usuario = await dataSource
      .getRepository(User)
      .findOneOrFail({ where: { id: cliente.id } });
    expect(usuario.freeSongUsed).toBe(false);

    await pedir(cliente.token).expect(201);
    expect(await saldoDe(cliente.id)).toBe(0);
  });

  it('7) sin correo verificado no hay canción gratis (antifraude)', async () => {
    const cliente = await crearCliente({
      etiqueta: 'sinverificar',
      correoVerificado: false,
      yaUsoGratis: false,
      creditos: 0,
    });

    const res = await pedir(cliente.token).expect(400);
    expect(res.body.message).toContain('No te alcanzan los créditos');
  });

  it('8) la invariante se sostiene: SUM(amount) = balance en todas las cuentas', async () => {
    const descuadres = await dataSource.query<unknown[]>(
      `SELECT ca.id
         FROM credit_accounts ca
         LEFT JOIN credit_transactions ct ON ct.credit_account_id = ca.id
        WHERE ca.venue_id = $1
        GROUP BY ca.id, ca.balance
       HAVING ca.balance <> COALESCE(SUM(ct.amount), 0)`,
      [venue.id],
    );

    // Debe ser SIEMPRE cero. Si esto devuelve filas, hay corrupción.
    expect(descuadres).toHaveLength(0);
  });
});
