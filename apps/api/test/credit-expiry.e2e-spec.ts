// apps/api/test/credit-expiry.e2e-spec.ts
//
// Expiración de créditos por inactividad (ADR 0006 + enmienda de 12 meses).
//
// La prueba que más importa es la 4: si el correo falla, NO se expira
// nada. El aviso no es cortesía, es precondición. Un módulo que le quita
// dinero a la gente tiene que fallar hacia el lado del cliente.
//
// El notificador real se reemplaza por uno falso (`overrideProvider`).
// Sin eso, correr las pruebas mandaría correos de verdad.

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
import { CreditExpiryService } from '../src/modules/credits/expiry/credit-expiry.service';
import {
  MAILER,
  CorreoSalida,
} from '../src/modules/notifications/mailer.interface';

const CLAVE = 'Prueba2026!';
const ROL_VENUE_ADMIN = 2;
const ROL_DJ = 3;
const MESES_DE_EXPIRACION = 12;
const DIAS_DE_AVISO = 30;

// Transporte de correo falso: guarda lo que se "mandó" en vez de
// mandarlo, y puede simular una caída del servidor SMTP.
class MailerFalso {
  correos: CorreoSalida[] = [];
  falla = false;

  enviar(correo: CorreoSalida): Promise<void> {
    if (this.falla) {
      return Promise.reject(new Error('SMTP caído (simulado)'));
    }
    this.correos.push(correo);
    return Promise.resolve();
  }

  reiniciar(): void {
    this.correos = [];
    this.falla = false;
  }

  paraNadie(email: string): boolean {
    return !this.correos.some((c) => c.to === email);
  }

  para(email: string): CorreoSalida | undefined {
    return this.correos.find((c) => c.to === email);
  }
}

describe('Expiración de créditos (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let credits: CreditsService;
  let expiry: CreditExpiryService;

  const correo = new MailerFalso();

  let venue: Venue;
  let tokenAdmin: string;

  const sufijo = Date.now();
  const creados: string[] = [];

  const crearUsuario = async (opciones: {
    etiqueta: string;
    rol: number;
    creditos?: number;
  }): Promise<{ id: string; token: string; email: string }> => {
    const users = dataSource.getRepository(User);
    const asignaciones = dataSource.getRepository(UserVenueRole);

    const email = `${opciones.etiqueta}.expira.${sufijo}@prueba.gt`;
    const usuario = await users.save(
      users.create({
        email,
        displayName: opciones.etiqueta,
        passwordHash: bcrypt.hashSync(CLAVE, 10),
        isEmailVerified: true,
        freeSongUsed: true,
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

    return { id: usuario.id, token: res.body.accessToken as string, email };
  };

  // Envejece una cuenta como si llevara N meses sin moverse. Es la única
  // forma de probar esto sin esperar un año.
  const envejecerCuenta = (userId: string, meses: number) =>
    dataSource.query(
      `UPDATE credit_accounts
          SET last_activity_at = now() - ($3::int * INTERVAL '1 month')
        WHERE user_id = $1 AND venue_id = $2`,
      [userId, venue.id, meses],
    );

  // Retrocede la fecha del aviso, para simular que ya pasaron sus días.
  const envejecerAviso = (userId: string, dias: number) =>
    dataSource.query(
      `UPDATE credit_accounts
          SET expiry_warning_sent_at = now() - ($3::int * INTERVAL '1 day')
        WHERE user_id = $1 AND venue_id = $2`,
      [userId, venue.id, dias],
    );

  const avisoDe = (userId: string) =>
    dataSource
      .query<Array<{ expiry_warning_sent_at: Date | null }>>(
        `SELECT expiry_warning_sent_at FROM credit_accounts
          WHERE user_id = $1 AND venue_id = $2`,
        [userId, venue.id],
      )
      .then((filas) => filas[0]?.expiry_warning_sent_at ?? null);

  const saldoDe = (userId: string) => credits.getBalance(userId, venue.id);

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      // Sin esto, correr las pruebas manda correos de verdad.
      .overrideProvider(MAILER)
      .useValue(correo)
      .compile();

    app = moduleFixture.createNestApplication();
    setupApp(app);
    await app.init();

    dataSource = app.get(DataSource);
    credits = app.get(CreditsService);
    expiry = app.get(CreditExpiryService);

    venue = await dataSource.getRepository(Venue).save(
      dataSource.getRepository(Venue).create({
        name: `Bar Expiración ${sufijo}`,
        type: 'bar',
        creditExpiryMonths: MESES_DE_EXPIRACION,
      }),
    );

    const admin = await crearUsuario({
      etiqueta: 'admin',
      rol: ROL_VENUE_ADMIN,
    });
    tokenAdmin = admin.token;
  }, 60000);

  beforeEach(() => correo.reiniciar());

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

    // notification_deliveries es append-only con trigger: un DELETE en
    // cascada desde users lo dispara y revienta la limpieza.
    await dataSource.query(
      `ALTER TABLE notification_deliveries DISABLE TRIGGER trg_notification_deliveries_immutable`,
    );
    if (creados.length > 0) {
      await dataSource.query(
        `DELETE FROM notification_deliveries
          WHERE notification_id IN
            (SELECT id FROM notifications WHERE user_id = ANY($1::uuid[]))`,
        [creados],
      );
      await dataSource.query(
        `DELETE FROM notifications WHERE user_id = ANY($1::uuid[])`,
        [creados],
      );
    }
    await dataSource.query(
      `ALTER TABLE notification_deliveries ENABLE TRIGGER trg_notification_deliveries_immutable`,
    );

    await dataSource.query(`DELETE FROM credit_accounts WHERE venue_id = $1`, [
      venue.id,
    ]);
    await dataSource.query(`DELETE FROM user_venue_roles WHERE venue_id = $1`, [
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

  it('1) a los 11 meses y 1 día se avisa, y el correo dice cuánto y cuándo', async () => {
    const cliente = await crearUsuario({
      etiqueta: 'poravisar',
      rol: ROL_VENUE_ADMIN,
      creditos: 12,
    });

    // 11 meses y pico: entra en la ventana de 30 días previos.
    await envejecerCuenta(cliente.id, 11);
    await dataSource.query(
      `UPDATE credit_accounts
          SET last_activity_at = last_activity_at - INTERVAL '10 days'
        WHERE user_id = $1 AND venue_id = $2`,
      [cliente.id, venue.id],
    );

    const avisadas = await expiry.avisarSaldosPorExpirar();
    expect(avisadas).toBeGreaterThanOrEqual(1);

    // ---- CANAL 1: el correo -----------------------------------
    const mio = correo.para(cliente.email);
    expect(mio).toBeDefined();
    expect(mio?.subject).toContain(venue.name);
    expect(mio?.text).toContain('Q12');

    // ---- CANAL 2: el mensaje dentro de la app -----------------
    // Los dos, no uno u otro: el correo puede caer en spam y el mensaje
    // en la app solo lo ve quien entra.
    const [enApp] = await dataSource.query<
      Array<{ title: string; body: string; email_status: string }>
    >(
      `SELECT title, body, email_status FROM notifications
        WHERE user_id = $1 AND type = 'credits_expiring'`,
      [cliente.id],
    );
    expect(enApp).toBeDefined();
    expect(enApp.title).toContain('Q12');
    expect(enApp.email_status).toBe('sent');

    // ---- LA BITÁCORA ------------------------------------------
    // Sin registro de qué se mandó y a quién, no se puede demostrar que
    // se avisó — y eso es lo que respalda quitarle el saldo a alguien.
    const [bitacora] = await dataSource.query<
      Array<{ channel: string; status: string; destination: string }>
    >(
      `SELECT d.channel, d.status, d.destination
         FROM notification_deliveries d
         JOIN notifications n ON n.id = d.notification_id
        WHERE n.user_id = $1 AND d.channel = 'email'`,
      [cliente.id],
    );
    expect(bitacora).toBeDefined();
    expect(bitacora.status).toBe('sent');
    expect(bitacora.destination).toBe(cliente.email);

    expect(await avisoDe(cliente.id)).not.toBeNull();

    // Y el saldo sigue intacto: avisar no es cobrar.
    expect(await saldoDe(cliente.id)).toBe(12);
  }, 60000);

  it('2) no se avisa dos veces a la misma cuenta', async () => {
    const cliente = await crearUsuario({
      etiqueta: 'dobleaviso',
      rol: ROL_VENUE_ADMIN,
      creditos: 5,
    });
    await envejecerCuenta(cliente.id, 12);

    await expiry.avisarSaldosPorExpirar();
    expect(correo.para(cliente.email)).toBeDefined();

    // Segunda corrida el mismo día: la marca la deja fuera del WHERE.
    correo.reiniciar();
    await expiry.avisarSaldosPorExpirar();
    expect(correo.paraNadie(cliente.email)).toBe(true);
  }, 60000);

  it('3) una cuenta avisada y vencida expira como renglón del libro mayor', async () => {
    const cliente = await crearUsuario({
      etiqueta: 'expirada',
      rol: ROL_VENUE_ADMIN,
      creditos: 12,
    });
    await envejecerCuenta(cliente.id, 13);
    await expiry.avisarSaldosPorExpirar();
    await envejecerAviso(cliente.id, DIAS_DE_AVISO + 1);

    const expiradas = await expiry.expirarSaldosInactivos();
    expect(expiradas).toBeGreaterThanOrEqual(1);

    expect(await saldoDe(cliente.id)).toBe(0);

    // NUNCA un reseteo silencioso: tiene que existir el renglón, con su
    // monto negativo y su razón escrita.
    const [renglon] = await dataSource.query<
      Array<{ type: string; amount: number; reason: string | null }>
    >(
      `SELECT ct.type, ct.amount, ct.reason
         FROM credit_transactions ct
         JOIN credit_accounts ca ON ca.id = ct.credit_account_id
        WHERE ca.user_id = $1 AND ca.venue_id = $2 AND ct.type = 'expiration'`,
      [cliente.id, venue.id],
    );

    expect(renglon).toBeDefined();
    expect(renglon.amount).toBe(-12);
    expect(renglon.reason).toContain('12 meses sin actividad');
  }, 60000);

  // ==============================================================
  // LA PRUEBA QUE PROTEGE AL CLIENTE
  // ==============================================================
  it('4) si el correo falla, NO se expira nada — el aviso es precondición', async () => {
    const cliente = await crearUsuario({
      etiqueta: 'smtpcaido',
      rol: ROL_VENUE_ADMIN,
      creditos: 30,
    });
    await envejecerCuenta(cliente.id, 14);

    // El servidor de correo está caído.
    correo.falla = true;
    const avisadas = await expiry.avisarSaldosPorExpirar();

    // No se avisó a nadie, y la cuenta quedó SIN marcar — mañana se
    // reintenta sola.
    expect(avisadas).toBe(0);
    expect(await avisoDe(cliente.id)).toBeNull();

    // Y aunque lleve 14 meses vencida, el job de expiración no la toca.
    await expiry.expirarSaldosInactivos();
    expect(await saldoDe(cliente.id)).toBe(30);

    // El mensaje EN LA APP sí existe: el aviso se creó, lo que falló fue
    // el correo. Pero eso NO alcanza para expirar — quien no entra en
    // doce meses tampoco va a ver el mensaje, y es exactamente el
    // cliente al que estamos por quitarle el dinero.
    const [enApp] = await dataSource.query<Array<{ email_status: string }>>(
      `SELECT email_status FROM notifications
        WHERE user_id = $1 AND type = 'credits_expiring'`,
      [cliente.id],
    );
    expect(enApp).toBeDefined();
    expect(enApp.email_status).toBe('failed');

    // Y el fallo quedó en la bitácora con su motivo. Sin ese registro no
    // habría forma de saber por qué esa cuenta lleva meses sin expirar.
    const [bitacora] = await dataSource.query<
      Array<{ status: string; error: string | null }>
    >(
      `SELECT d.status, d.error
         FROM notification_deliveries d
         JOIN notifications n ON n.id = d.notification_id
        WHERE n.user_id = $1 AND d.channel = 'email'`,
      [cliente.id],
    );
    expect(bitacora).toBeDefined();
    expect(bitacora.status).toBe('failed');
    expect(bitacora.error).toContain('SMTP');
  }, 60000);

  it('5) si el cliente vuelve, el aviso se borra y ya no expira', async () => {
    const cliente = await crearUsuario({
      etiqueta: 'volvio',
      rol: ROL_VENUE_ADMIN,
      creditos: 10,
    });
    await envejecerCuenta(cliente.id, 13);
    await expiry.avisarSaldosPorExpirar();
    await envejecerAviso(cliente.id, DIAS_DE_AVISO + 1);

    // El cliente vuelve y recarga. Cualquier movimiento sirve.
    await credits.applyTransaction({
      userId: cliente.id,
      venueId: venue.id,
      type: 'topup_manual',
      amount: 5,
      paymentMethod: 'efectivo_recepcion',
    });

    // La marca se borró sola dentro de applyLines.
    expect(await avisoDe(cliente.id)).toBeNull();

    await expiry.expirarSaldosInactivos();
    expect(await saldoDe(cliente.id)).toBe(15);
  }, 60000);

  it('6) una cuenta reciente ni se avisa ni se expira', async () => {
    const cliente = await crearUsuario({
      etiqueta: 'reciente',
      rol: ROL_VENUE_ADMIN,
      creditos: 20,
    });

    await expiry.avisarSaldosPorExpirar();
    expect(correo.paraNadie(cliente.email)).toBe(true);

    await expiry.expirarSaldosInactivos();
    expect(await saldoDe(cliente.id)).toBe(20);
  }, 60000);

  it('7) el dueño puede poner 0: sus créditos no expiran nunca', async () => {
    await request(app.getHttpServer())
      .patch(`/venues/${venue.id}/policies`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ creditExpiryMonths: 0 })
      .expect(200);

    const cliente = await crearUsuario({
      etiqueta: 'nuncaexpira',
      rol: ROL_VENUE_ADMIN,
      creditos: 40,
    });
    await envejecerCuenta(cliente.id, 36); // tres años quieta

    await expiry.avisarSaldosPorExpirar();
    expect(correo.paraNadie(cliente.email)).toBe(true);

    await expiry.expirarSaldosInactivos();
    expect(await saldoDe(cliente.id)).toBe(40);

    // Se deja el local como estaba para no afectar otras pruebas.
    await request(app.getHttpServer())
      .patch(`/venues/${venue.id}/policies`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ creditExpiryMonths: MESES_DE_EXPIRACION })
      .expect(200);
  }, 60000);

  it('8) las políticas se validan: nada de meses negativos ni de 120', async () => {
    await request(app.getHttpServer())
      .patch(`/venues/${venue.id}/policies`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ creditExpiryMonths: -1 })
      .expect(400);

    // Un dedazo (120 en vez de 12) sin techo sería indetectable hasta
    // que alguien reclamara en 2036.
    await request(app.getHttpServer())
      .patch(`/venues/${venue.id}/policies`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ creditExpiryMonths: 120 })
      .expect(400);

    await request(app.getHttpServer())
      .patch(`/venues/${venue.id}/policies`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ sessionTimeoutHours: 0 })
      .expect(400);
  }, 60000);

  it('9) un DJ no puede cambiar las políticas del local', async () => {
    const dj = await crearUsuario({ etiqueta: 'djsinpermiso', rol: ROL_DJ });

    await request(app.getHttpServer())
      .patch(`/venues/${venue.id}/policies`)
      .set('Authorization', `Bearer ${dj.token}`)
      .send({ creditExpiryMonths: 1 })
      .expect(403);
  }, 60000);

  // ==============================================================
  // CAMBIO DE REGLAS — solo se avisa cuando el riesgo AUMENTA
  // ==============================================================
  it('10) si el dueño acorta el plazo, se avisa a quien tiene saldo', async () => {
    const conSaldo = await crearUsuario({
      etiqueta: 'afectado',
      rol: ROL_VENUE_ADMIN,
      creditos: 25,
    });
    const sinSaldo = await crearUsuario({
      etiqueta: 'sinsaldo',
      rol: ROL_VENUE_ADMIN,
    });

    // Se le avisó bajo el plazo viejo: la marca queda puesta.
    await envejecerCuenta(conSaldo.id, 12);
    await expiry.avisarSaldosPorExpirar();
    expect(await avisoDe(conSaldo.id)).not.toBeNull();

    // El dueño baja de 12 a 3 meses.
    await request(app.getHttpServer())
      .patch(`/venues/${venue.id}/policies`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ creditExpiryMonths: 3 })
      .expect(200);

    const [aviso] = await dataSource.query<
      Array<{ title: string; body: string; email_status: string }>
    >(
      `SELECT title, body, email_status FROM notifications
        WHERE user_id = $1 AND type = 'rules_changed'`,
      [conSaldo.id],
    );
    expect(aviso).toBeDefined();
    expect(aviso.body).toContain('Q25');
    expect(aviso.body).toContain('3 meses');
    // El correo lo agrupa el job de la mañana: un cambio de política no
    // dispara cien correos de golpe.
    expect(aviso.email_status).toBe('pending');

    // A quien tiene cero no le cambia nada, así que no se le escribe.
    const deNadie = await dataSource.query<Array<{ id: string }>>(
      `SELECT id FROM notifications WHERE user_id = $1`,
      [sinSaldo.id],
    );
    expect(deNadie).toHaveLength(0);

    // LA PARTE QUE PROTEGE EL DINERO: el aviso previo se reinicia.
    //
    // Sin esto, la cuenta seguía marcada como avisada bajo el plazo VIEJO
    // y podía expirar casi de inmediato con el plazo nuevo — perdiendo el
    // saldo por un cambio que el cliente no pidió.
    expect(await avisoDe(conSaldo.id)).toBeNull();

    await request(app.getHttpServer())
      .patch(`/venues/${venue.id}/policies`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ creditExpiryMonths: MESES_DE_EXPIRACION })
      .expect(200);
  }, 60000);

  it('11) alargar el plazo o ponerlo en "nunca" NO genera aviso', async () => {
    const cliente = await crearUsuario({
      etiqueta: 'buenanoticia',
      rol: ROL_VENUE_ADMIN,
      creditos: 15,
    });

    // De 12 a 24: el dinero está MÁS seguro. No se molesta a nadie.
    await request(app.getHttpServer())
      .patch(`/venues/${venue.id}/policies`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ creditExpiryMonths: 24 })
      .expect(200);

    // De 24 a 0 ("nunca expiran"): mejor todavía.
    await request(app.getHttpServer())
      .patch(`/venues/${venue.id}/policies`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ creditExpiryMonths: 0 })
      .expect(200);

    const avisos = await dataSource.query<Array<{ id: string }>>(
      `SELECT id FROM notifications
        WHERE user_id = $1 AND type = 'rules_changed'`,
      [cliente.id],
    );
    expect(avisos).toHaveLength(0);

    // PERO de 0 a 12 SÍ avisa: dinero que estaba a salvo ahora tiene
    // fecha de vencimiento. Es el peor caso, y una comparación ingenua
    // (`12 < 0`) lo leería como una mejora.
    await request(app.getHttpServer())
      .patch(`/venues/${venue.id}/policies`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ creditExpiryMonths: MESES_DE_EXPIRACION })
      .expect(200);

    const despues = await dataSource.query<Array<{ id: string }>>(
      `SELECT id FROM notifications
        WHERE user_id = $1 AND type = 'rules_changed'`,
      [cliente.id],
    );
    expect(despues).toHaveLength(1);
  }, 60000);
});
