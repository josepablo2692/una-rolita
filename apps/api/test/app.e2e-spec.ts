import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import Redis from 'ioredis';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.module';

describe('AppController (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    // app.close() sabe cerrar la conexión de Postgres/TypeORM sola,
    // pero el cliente de Redis lo creamos "a mano" (new Redis(...)),
    // así que NestJS no sabe cómo cerrarlo por su cuenta. Sin esto,
    // el socket de Redis se queda abierto y Jest nunca detecta que
    // el proceso puede terminar (esto fue lo que colgó el CI horas).
    const redisClient: Redis = app.get(REDIS_CLIENT);
    await redisClient.quit();

    await app.close();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });
});
