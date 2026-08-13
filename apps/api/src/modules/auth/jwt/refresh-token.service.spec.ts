// apps/api/src/modules/auth/jwt/refresh-token.service.spec.ts
//
// ROADMAP — Épica 7, deuda técnica de pruebas. A diferencia de
// OtpService, aquí mockeamos SOLO Redis y ConfigService — JwtService
// corre real, porque firmar/verificar JWT es rápido, determinista,
// y no toca infraestructura externa.

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { RefreshTokenService } from './refresh-token.service';
import { REDIS_CLIENT } from '../../../redis/redis.module';

describe('RefreshTokenService', () => {
  let service: RefreshTokenService;

  const mockRedis = {
    set: jest.fn(),
    get: jest.fn(),
    del: jest.fn(),
    sadd: jest.fn(),
    srem: jest.fn(),
    smembers: jest.fn(),
    expire: jest.fn(),
  };

  // ConfigService real de Nest, pero con .get() reemplazado por un
  // mock — así controlamos qué "valores de .env" ve el servicio,
  // sin necesitar un .env real cargado durante las pruebas.
  const mockConfigService = {
    get: jest.fn((key: string) => {
      if (key === 'JWT_REFRESH_SECRET') return 'test-secret-para-pruebas';
      if (key === 'JWT_REFRESH_EXPIRES_IN') return '7d';
      return null;
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    // clearAllMocks borra las llamadas registradas, pero también
    // borraría la implementación de mockConfigService.get de arriba
    // si no la reafirmamos aquí — por eso se repite dentro de beforeEach.
    mockConfigService.get = jest.fn((key: string) => {
      if (key === 'JWT_REFRESH_SECRET') return 'test-secret-para-pruebas';
      if (key === 'JWT_REFRESH_EXPIRES_IN') return '7d';
      return null;
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RefreshTokenService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: REDIS_CLIENT, useValue: mockRedis },
      ],
    }).compile();

    service = module.get<RefreshTokenService>(RefreshTokenService);
  });

  describe('generate', () => {
    it('firma un token y lo registra en Redis en AMBAS claves', async () => {
      const token = await service.generate('user-123');

      expect(token).toEqual(expect.any(String));
      // Confirma el registro individual (para verify rápido)
      expect(mockRedis.set).toHaveBeenCalledWith(
        expect.stringMatching(/^refresh:/),
        'user-123',
        'EX',
        expect.any(Number),
      );
      // Confirma el registro en el set del usuario (para revocar todo)
      expect(mockRedis.sadd).toHaveBeenCalledWith(
        'refresh:user:user-123',
        expect.any(String),
      );
    });
  });

  describe('verify', () => {
    it('acepta un token válido cuyo jti sigue vivo en Redis', async () => {
      const token = await service.generate('user-456');
      mockRedis.get.mockResolvedValue('user-456'); // simula que Redis SÍ lo tiene

      const result = await service.verify(token);

      expect(result.userId).toBe('user-456');
    });

    it('rechaza un token con firma inválida (manipulado o de otro secret)', async () => {
      const tokenFalso = 'esto.no.es.un.jwt.valido';

      await expect(service.verify(tokenFalso)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rechaza un token válido pero YA REVOCADO (jti no está en Redis)', async () => {
      const token = await service.generate('user-789');
      mockRedis.get.mockResolvedValue(null); // simula que Redis ya lo borró

      await expect(service.verify(token)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('revoke', () => {
    it('borra el jti individual Y lo saca del set del usuario', async () => {
      await service.revoke('jti-abc', 'user-123');

      expect(mockRedis.del).toHaveBeenCalledWith('refresh:jti-abc');
      expect(mockRedis.srem).toHaveBeenCalledWith(
        'refresh:user:user-123',
        'jti-abc',
      );
    });
  });

  describe('revokeAllForUser', () => {
    it('borra TODOS los jti del set, más el set mismo', async () => {
      mockRedis.smembers.mockResolvedValue(['jti-1', 'jti-2', 'jti-3']);

      await service.revokeAllForUser('user-123');

      expect(mockRedis.del).toHaveBeenCalledWith(
        'refresh:jti-1',
        'refresh:jti-2',
        'refresh:jti-3',
      );
      expect(mockRedis.del).toHaveBeenCalledWith('refresh:user:user-123');
    });

    it('no truena si el usuario no tiene ninguna sesión activa', async () => {
      mockRedis.smembers.mockResolvedValue([]); // set vacío

      await expect(
        service.revokeAllForUser('user-sin-sesiones'),
      ).resolves.not.toThrow();
    });
  });
});
