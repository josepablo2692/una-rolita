// apps/api/test/credits.e2e-spec.ts
//
// Prueba de INTEGRACIÓN contra Postgres real, no unitaria con mocks.
// El comportamiento que nos importa (SELECT ... FOR UPDATE) ocurre dentro
// de la base de datos: si simulamos el DataSource solo comprobaríamos que
// llamamos bien a TypeORM, no que el bloqueo funcione.

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.module';
import { CreditsService } from '../src/modules/credits/credits.service';
import { CreditAccount } from '../src/modules/credits/entities/credit-account.entity';
import { CreditTransaction } from '../src/modules/credits/entities/credit-transaction.entity';
import { User } from '../src/modules/auth/entities/user.entity';
import { Venue } from '../src/modules/venues/entities/venue.entity';

describe('CreditsService — integración con base real', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let credits: CreditsService;
  let venue: Venue;

  const sufijo = Date.now();
  const clientes: string[] = []; // ids creados, para limpiar al final

  // Cada prueba usa su PROPIO cliente: así el orden de ejecución no
  // importa y una prueba no puede contaminar a la siguiente.
  const crearCliente = async (etiqueta: string): Promise<string> => {
    const repo = dataSource.getRepository(User);
    const u = await repo.save(
      repo.create({
        email: `credito.${etiqueta}.${sufijo}@prueba.gt`,
        displayName: `Cliente ${etiqueta}`,
        passwordHash: null,
        isEmailVerified: true,
      }),
    );
    clientes.push(u.id);
    return u.id;
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    dataSource = app.get(DataSource);
    credits = app.get(CreditsService);

    const venues = dataSource.getRepository(Venue);
    venue = await venues.save(
      venues.create({ name: `Bar Creditos ${sufijo}`, type: 'bar' }),
    );
  }, 30000);

  afterAll(async () => {
    // El trigger de inmutabilidad bloquea DELETE sobre el libro mayor —
    // así está diseñado. Para limpiar datos de prueba hay que desactivarlo
    // a propósito, y que cueste este trabajo es justamente la señal de que
    // la protección es real y no una convención.
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

    await dataSource.query(`DELETE FROM credit_accounts WHERE venue_id = $1`, [
      venue.id,
    ]);
    if (clientes.length > 0) {
      await dataSource.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [
        clientes,
      ]);
    }
    await dataSource.query(`DELETE FROM venues WHERE id = $1`, [venue.id]);

    const redis: Redis = app.get(REDIS_CLIENT);
    await redis.quit();
    await app.close();
  }, 30000);

  it('la primera carga abre la cuenta y deja el saldo correcto', async () => {
    const userId = await crearCliente('primera');

    const mov = await credits.applyTransaction({
      userId,
      venueId: venue.id,
      type: 'topup_manual',
      amount: 10,
      paymentMethod: 'efectivo_recepcion',
      cashAmount: 10,
    });

    expect(mov.amount).toBe(10);
    expect(mov.balanceAfter).toBe(10);
    expect(await credits.getBalance(userId, venue.id)).toBe(10);
  });

  it('rechaza un cobro que dejaría el saldo negativo', async () => {
    const userId = await crearCliente('insuficiente');

    await credits.applyTransaction({
      userId,
      venueId: venue.id,
      type: 'topup_manual',
      amount: 3,
    });

    await expect(
      credits.applyTransaction({
        userId,
        venueId: venue.id,
        type: 'charge_jump',
        amount: -5, // solo tiene 3
      }),
    ).rejects.toThrow(/Saldo insuficiente/);

    // Y el saldo quedó intacto: la transacción hizo ROLLBACK completo.
    expect(await credits.getBalance(userId, venue.id)).toBe(3);
  });

  it('la misma llave de idempotencia no cobra dos veces', async () => {
    const userId = await crearCliente('idempotencia');
    const llave = `prueba-doble-clic-${sufijo}`;

    const primera = await credits.applyTransaction({
      userId,
      venueId: venue.id,
      type: 'topup_manual',
      amount: 20,
      idempotencyKey: llave,
    });

    const segunda = await credits.applyTransaction({
      userId,
      venueId: venue.id,
      type: 'topup_manual',
      amount: 20,
      idempotencyKey: llave,
    });

    // Mismo movimiento devuelto, no uno nuevo.
    expect(segunda.id).toBe(primera.id);
    // Y el saldo se movió UNA sola vez.
    expect(await credits.getBalance(userId, venue.id)).toBe(20);
  });

  // ============================================================
  // LA PRUEBA QUE JUSTIFICA TODO EL DISEÑO
  //
  // Diez cargas de 5 créditos lanzadas AL MISMO TIEMPO. Sin el
  // SELECT ... FOR UPDATE, varias leerían el mismo saldo y se pisarían:
  // el resultado sería menor que 50 y variaría en cada corrida. Con el
  // bloqueo, es exactamente 50, siempre.
  // ============================================================
  it('10 cargas simultáneas de 5 dejan exactamente 50 créditos', async () => {
    const userId = await crearCliente('concurrencia');

    await Promise.all(
      Array.from({ length: 10 }, () =>
        credits.applyTransaction({
          userId,
          venueId: venue.id,
          type: 'topup_manual',
          amount: 5,
          paymentMethod: 'efectivo_recepcion',
          cashAmount: 5,
        }),
      ),
    );

    expect(await credits.getBalance(userId, venue.id)).toBe(50);

    // Y la invariante del sistema se sostiene: el saldo materializado
    // coincide con la suma del libro mayor.
    const cuenta = await dataSource
      .getRepository(CreditAccount)
      .findOneOrFail({ where: { userId, venueId: venue.id } });

    const integridad = await credits.verifyIntegrity(cuenta.id);
    expect(integridad.sumaLedger).toBe(50);
    expect(integridad.ok).toBe(true);
  }, 30000);

  it('el trigger de la base impide editar el libro mayor', async () => {
    const userId = await crearCliente('inmutable');

    const mov = await credits.applyTransaction({
      userId,
      venueId: venue.id,
      type: 'topup_manual',
      amount: 7,
    });

    // Ni siquiera con SQL directo, saltándose el ORM por completo.
    await expect(
      dataSource.query(
        `UPDATE credit_transactions SET amount = 999 WHERE id = $1`,
        [mov.id],
      ),
    ).rejects.toThrow(/append-only/);

    const sinCambios = await dataSource
      .getRepository(CreditTransaction)
      .findOneOrFail({ where: { id: mov.id } });
    expect(sinCambios.amount).toBe(7);
  });
});
