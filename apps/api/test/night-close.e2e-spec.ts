// apps/api/test/night-close.e2e-spec.ts
//
// Cierre de la noche (venue_sessions).
//
// La cola NO es perpetua: pertenece a una noche. Cerrarla no es poner una
// fecha — es reconocer que los pedidos que quedaron nunca van a sonar y
// devolver ese dinero (ADR 0007).
//
// Las dos pruebas que más importan aquí:
//   - la 8, porque el cierre automático debe medir la noche con la hora
//     de la última actividad, no con la del job. Si se midiera con el
//     reloj del job, la métrica de duración sería inservible justo en los
//     locales que peor operan.
//   - la 6, porque un pedido que llega después del cierre tiene que
//     pertenecer a la noche siguiente, no quedar colgado de una cerrada.

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import Redis from 'ioredis';
import { DataSource, IsNull } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';

import { AppModule } from '../src/app.module';
import { setupApp } from '../src/common/setup-app';
import { REDIS_CLIENT } from '../src/redis/redis.module';
import { User } from '../src/modules/auth/entities/user.entity';
import { UserVenueRole } from '../src/modules/auth/entities/user-venue-role.entity';
import { Venue } from '../src/modules/venues/entities/venue.entity';
import { VenueTable } from '../src/modules/venues/entities/venue-table.entity';
import { VenueSession } from '../src/modules/venues/entities/venue-session.entity';
import { QueueRequest } from '../src/modules/queue/entities/queue-request.entity';
import { QueueService } from '../src/modules/queue/queue.service';
import { CreditsService } from '../src/modules/credits/credits.service';

const CLAVE = 'Prueba2026!';
const ROL_VENUE_ADMIN = 2;
const ROL_DJ = 3;
const ROL_STAFF = 4;
const PRECIO_CANCION = 1;
const PRECIO_SALTO = 5;
const TIMEOUT_HORAS = 6;

describe('Cierre de la noche (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let credits: CreditsService;
  let queue: QueueService;

  let venue: Venue;
  let mesa: VenueTable;
  let tokenDj: string;

  const sufijo = Date.now();
  const creados: string[] = [];

  const crearUsuario = async (opciones: {
    etiqueta: string;
    rol: number;
    yaUsoGratis?: boolean;
    creditos?: number;
  }): Promise<{ id: string; token: string }> => {
    const users = dataSource.getRepository(User);
    const asignaciones = dataSource.getRepository(UserVenueRole);

    const email = `${opciones.etiqueta}.noche.${sufijo}@prueba.gt`;
    const usuario = await users.save(
      users.create({
        email,
        displayName: opciones.etiqueta,
        passwordHash: bcrypt.hashSync(CLAVE, 10),
        isEmailVerified: true,
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

  const sesionDe = async (requestId: string): Promise<string> => {
    const pedido = await dataSource
      .getRepository(QueueRequest)
      .findOneOrFail({ where: { id: requestId } });
    return pedido.sessionId;
  };

  const saldoDe = (userId: string) => credits.getBalance(userId, venue.id);

  const cerrarNoche = () =>
    request(app.getHttpServer())
      .post(`/venues/${venue.id}/queue/close-night`)
      .set('Authorization', `Bearer ${tokenDj}`);

  // Deja el local sin noche abierta. Cada prueba parte de cero sin
  // depender del orden en que corrieron las anteriores.
  //
  // Revienta ante cualquier respuesta inesperada a propósito. Antes se
  // tragaba el error en silencio, y un 500 aquí dejaba la noche abierta
  // haciendo fallar la prueba SIGUIENTE — que señalaba al lugar
  // equivocado. Un ayudante de limpieza que falla callado hace perder
  // más tiempo que el bug original.
  const dejarSinNocheAbierta = async (): Promise<void> => {
    const res = await cerrarNoche();
    // 201 = se cerró. 400 = no había ninguna abierta, que también sirve.
    if (res.status !== 201 && res.status !== 400) {
      throw new Error(
        `No se pudo dejar el local sin noche abierta: ${res.status} ${JSON.stringify(res.body)}`,
      );
    }
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    setupApp(app);
    await app.init();

    dataSource = app.get(DataSource);
    credits = app.get(CreditsService);
    queue = app.get(QueueService);

    venue = await dataSource.getRepository(Venue).save(
      dataSource.getRepository(Venue).create({
        name: `Bar Cierre ${sufijo}`,
        type: 'bar',
        songPrice: PRECIO_CANCION,
        queueJumpPrice: PRECIO_SALTO,
        sessionTimeoutHours: TIMEOUT_HORAS,
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
    // Las sesiones se borran DESPUÉS de los pedidos: queue_requests las
    // referencia con una llave foránea.
    await dataSource.query(`DELETE FROM venue_sessions WHERE venue_id = $1`, [
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

  it('1) la noche se abre sola con el primer pedido, sin apretar ningún botón', async () => {
    const cliente = await crearUsuario({
      etiqueta: 'apertura',
      rol: ROL_VENUE_ADMIN,
      creditos: 20,
    });

    // Antes del primer pedido no existe ninguna noche.
    const antes = await dataSource
      .getRepository(VenueSession)
      .count({ where: { venueId: venue.id } });
    expect(antes).toBe(0);

    const pedido = await pedir(cliente.token);

    const sesion = await dataSource
      .getRepository(VenueSession)
      .findOneOrFail({ where: { venueId: venue.id, closedAt: IsNull() } });

    expect(await sesionDe(pedido)).toBe(sesion.id);
    expect(sesion.closedAt).toBeNull();

    // Se deja el local sin noche abierta: si no, el pedido de esta
    // prueba se reembolsaría en el cierre de la siguiente y le inflaría
    // los números. Cada prueba tiene que valerse por sí sola.
    await dejarSinNocheAbierta();
  }, 60000);

  it('2) al cerrar, toda la cola pendiente se reembolsa completa', async () => {
    const conSalto = await crearUsuario({
      etiqueta: 'salto',
      rol: ROL_VENUE_ADMIN,
      creditos: 20,
    });
    const normal = await crearUsuario({
      etiqueta: 'normal',
      rol: ROL_VENUE_ADMIN,
      creditos: 20,
    });

    await pedir(conSalto.token, true);
    await pedir(normal.token);

    expect(await saldoDe(conSalto.id)).toBe(20 - PRECIO_SALTO);
    expect(await saldoDe(normal.id)).toBe(20 - PRECIO_CANCION);

    const res = await cerrarNoche().expect(201);

    // El local no entregó el servicio: vuelve todo, incluido el salto.
    expect(await saldoDe(conSalto.id)).toBe(20);
    expect(await saldoDe(normal.id)).toBe(20);

    expect(res.body.abierta).toBe(false);
    expect(res.body.closedAutomatically).toBe(false);
    expect(res.body.cancionesEnCola).toBe(0);
    expect(res.body.creditosDevueltosAlCerrar).toBe(
      PRECIO_SALTO + PRECIO_CANCION,
    );
  }, 60000);

  it('3) al cerrar se restituye la canción gratis que quedó sin sonar', async () => {
    const cliente = await crearUsuario({
      etiqueta: 'gratis',
      rol: ROL_VENUE_ADMIN,
      yaUsoGratis: false,
      creditos: 0,
    });

    await pedir(cliente.token);

    let usuario = await dataSource
      .getRepository(User)
      .findOneOrFail({ where: { id: cliente.id } });
    expect(usuario.freeSongUsed).toBe(true);

    await cerrarNoche().expect(201);

    // Su neto fue cero: no hay crédito que devolver. Pero perdió la
    // promoción sin recibir nada, y el incumplimiento fue del local.
    expect(await saldoDe(cliente.id)).toBe(0);
    usuario = await dataSource
      .getRepository(User)
      .findOneOrFail({ where: { id: cliente.id } });
    expect(usuario.freeSongUsed).toBe(false);
  }, 60000);

  it('4) cerrar dos veces seguidas devuelve 400: no hay doble reembolso', async () => {
    const cliente = await crearUsuario({
      etiqueta: 'doblecierre',
      rol: ROL_VENUE_ADMIN,
      creditos: 20,
    });
    await pedir(cliente.token);

    await cerrarNoche().expect(201);
    expect(await saldoDe(cliente.id)).toBe(20);

    // La segunda vez ya no hay noche abierta que cerrar.
    await cerrarNoche().expect(400);
    expect(await saldoDe(cliente.id)).toBe(20);
  }, 60000);

  it('5) un mesero no puede cerrar la noche: mueve dinero', async () => {
    const mesero = await crearUsuario({ etiqueta: 'mesero', rol: ROL_STAFF });
    const cliente = await crearUsuario({
      etiqueta: 'clientemesero',
      rol: ROL_VENUE_ADMIN,
      creditos: 20,
    });
    await pedir(cliente.token);

    await request(app.getHttpServer())
      .post(`/venues/${venue.id}/queue/close-night`)
      .set('Authorization', `Bearer ${mesero.token}`)
      .expect(403);

    // Y el cliente sigue con su pedido cobrado y en cola.
    expect(await saldoDe(cliente.id)).toBe(20 - PRECIO_CANCION);

    await dejarSinNocheAbierta();
  }, 60000);

  it('6) un pedido posterior al cierre pertenece a la noche SIGUIENTE', async () => {
    const cliente = await crearUsuario({
      etiqueta: 'nochesiguiente',
      rol: ROL_VENUE_ADMIN,
      creditos: 20,
    });

    const anoche = await pedir(cliente.token);
    const sesionAnoche = await sesionDe(anoche);

    await cerrarNoche().expect(201);

    const hoy = await pedir(cliente.token);
    const sesionHoy = await sesionDe(hoy);

    // Noches distintas. Si compartieran sesión, la cola de anoche
    // reaparecería hoy y los reembolsos nunca saldrían.
    expect(sesionHoy).not.toBe(sesionAnoche);

    const cerrada = await dataSource
      .getRepository(VenueSession)
      .findOneOrFail({ where: { id: sesionAnoche } });
    expect(cerrada.closedAt).not.toBeNull();

    await dejarSinNocheAbierta();
  }, 60000);

  it('7) el resumen cuadra: pedidas, sonadas, saltadas y créditos', async () => {
    const cliente = await crearUsuario({
      etiqueta: 'metricas',
      rol: ROL_VENUE_ADMIN,
      creditos: 50,
    });

    const sono = await pedir(cliente.token);
    const saltada = await pedir(cliente.token);
    await pedir(cliente.token); // esta queda en cola y se reembolsa al cerrar

    await request(app.getHttpServer())
      .patch(`/venues/${venue.id}/queue/${sono}/played`)
      .set('Authorization', `Bearer ${tokenDj}`)
      .expect(200);

    await request(app.getHttpServer())
      .patch(`/venues/${venue.id}/queue/${saltada}/skip`)
      .set('Authorization', `Bearer ${tokenDj}`)
      .expect(200);

    // La noche en curso, antes de cerrar.
    const enVivo = await request(app.getHttpServer())
      .get(`/venues/${venue.id}/queue/sessions/current`)
      .set('Authorization', `Bearer ${tokenDj}`)
      .expect(200);

    expect(enVivo.body.abierta).toBe(true);
    expect(enVivo.body.cancionesPedidas).toBe(3);
    expect(enVivo.body.cancionesSonadas).toBe(1);
    expect(enVivo.body.cancionesSaltadas).toBe(1);
    expect(enVivo.body.cancionesEnCola).toBe(1);

    const res = await cerrarNoche().expect(201);

    // Se cobraron 3 canciones; se devolvieron 2 (la saltada y la que
    // quedó en cola). El saldo lo confirma desde el otro lado.
    expect(res.body.cancionesPedidas).toBe(3);
    expect(res.body.cancionesSaltadas).toBe(2);
    expect(res.body.cancionesEnCola).toBe(0);
    expect(res.body.creditosGastados).toBe(3 * PRECIO_CANCION);
    expect(res.body.creditosReembolsados).toBe(2 * PRECIO_CANCION);
    expect(await saldoDe(cliente.id)).toBe(50 - PRECIO_CANCION);

    // Y el mismo resumen se puede volver a consultar después.
    const despues = await request(app.getHttpServer())
      .get(`/venues/${venue.id}/queue/sessions/${res.body.sessionId}`)
      .set('Authorization', `Bearer ${tokenDj}`)
      .expect(200);
    expect(despues.body.cancionesPedidas).toBe(3);
    expect(despues.body.abierta).toBe(false);
  }, 60000);

  // ==============================================================
  // LA PRUEBA QUE PROTEGE LA MÉTRICA
  //
  // El job corre cada media hora y puede detectar una noche muchas horas
  // después de que terminó de verdad. Si cerrara con su propio reloj, una
  // noche de 3 horas mediría 10. Aquí se fuerza ese escenario.
  // ==============================================================
  it('8) el cierre automático usa la última actividad, no la hora del job', async () => {
    const cliente = await crearUsuario({
      etiqueta: 'automatico',
      rol: ROL_VENUE_ADMIN,
      creditos: 20,
    });
    const pedido = await pedir(cliente.token);

    // El id se guarda ANTES de envejecerla. Al ponerle 10 horas de
    // antigüedad deja de ser la más reciente, así que buscarla después
    // por "la última abierta" traería otra sesión de otra prueba.
    const sesionId = await sesionDe(pedido);

    // Se envejece la noche: abrió hace 10 horas, última señal de vida
    // hace 7. Con un umbral de 6 horas, está vencida.
    await dataSource.query(
      `UPDATE venue_sessions
          SET opened_at = now() - INTERVAL '10 hours',
              last_activity_at = now() - INTERVAL '7 hours'
        WHERE id = $1`,
      [sesionId],
    );

    const cerradas = await queue.cerrarSesionesInactivas();
    expect(cerradas).toBeGreaterThanOrEqual(1);

    const sesion = await dataSource
      .getRepository(VenueSession)
      .findOneOrFail({ where: { id: sesionId } });

    expect(sesion.closedAt).not.toBeNull();
    expect(sesion.closedAutomatically).toBe(true);
    // Nadie la cerró: la cerró el sistema.
    expect(sesion.closedByUserId).toBeNull();

    // La duración medida son ~180 minutos (10h de apertura menos 7h de
    // silencio), NO las 600 del reloj del job.
    const duracion =
      ((sesion.closedAt as Date).getTime() -
        new Date(sesion.openedAt).getTime()) /
      60000;
    expect(duracion).toBeGreaterThan(170);
    expect(duracion).toBeLessThan(190);

    // Y el reembolso salió igual que en el cierre manual.
    expect(await saldoDe(cliente.id)).toBe(20);
  }, 60000);

  it('9) el cierre automático NO toca una noche que sigue activa', async () => {
    const cliente = await crearUsuario({
      etiqueta: 'activa',
      rol: ROL_VENUE_ADMIN,
      creditos: 20,
    });
    await pedir(cliente.token);

    // Cuatro horas de silencio con un umbral de seis: todavía no vence.
    await dataSource.query(
      `UPDATE venue_sessions
          SET last_activity_at = now() - INTERVAL '4 hours'
        WHERE venue_id = $1 AND closed_at IS NULL`,
      [venue.id],
    );

    await queue.cerrarSesionesInactivas();

    const abierta = await dataSource
      .getRepository(VenueSession)
      .count({ where: { venueId: venue.id, closedAt: IsNull() } });
    expect(abierta).toBe(1);

    // El pedido sigue cobrado y en cola: nadie lo reembolsó por error.
    expect(await saldoDe(cliente.id)).toBe(20 - PRECIO_CANCION);

    await dejarSinNocheAbierta();
  }, 60000);

  it('10) consultar la noche en curso cuando no hay ninguna devuelve 404', async () => {
    await request(app.getHttpServer())
      .get(`/venues/${venue.id}/queue/sessions/current`)
      .set('Authorization', `Bearer ${tokenDj}`)
      .expect(404);
  }, 60000);

  it('11) un pedido de una noche cerrada ya no se puede reproducir ni cancelar', async () => {
    const cliente = await crearUsuario({
      etiqueta: 'nocheresucitada',
      rol: ROL_VENUE_ADMIN,
      creditos: 20,
    });
    const pedido = await pedir(cliente.token);

    await cerrarNoche().expect(201);
    expect(await saldoDe(cliente.id)).toBe(20);

    // El cierre ya lo reembolsó. Si el DJ pudiera marcarlo como sonado,
    // el cliente se quedaría con el crédito devuelto Y con la canción.
    await request(app.getHttpServer())
      .patch(`/venues/${venue.id}/queue/${pedido}/played`)
      .set('Authorization', `Bearer ${tokenDj}`)
      .expect(400);

    // Y cancelarlo tampoco: sería un segundo reembolso del mismo pedido.
    await request(app.getHttpServer())
      .patch(`/venues/${venue.id}/queue/${pedido}/cancel`)
      .set('Authorization', `Bearer ${cliente.token}`)
      .expect(400);

    expect(await saldoDe(cliente.id)).toBe(20);
  }, 60000);

  it('12) un id de noche que no es UUID se rechaza con 400, no con un 500', async () => {
    await request(app.getHttpServer())
      .get(`/venues/${venue.id}/queue/sessions/esto-no-es-un-uuid`)
      .set('Authorization', `Bearer ${tokenDj}`)
      .expect(400);
  }, 60000);
});
