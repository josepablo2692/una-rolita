// apps/api/src/modules/auth/otp/otp.service.spec.ts
//
// ROADMAP — Épica 7, deuda técnica de pruebas. Prueba OtpService
// aislado, con Redis y OtpSender simulados (mocks) — no toca
// infraestructura real, corre en milisegundos.

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { OtpService } from './otp.service';
import { REDIS_CLIENT } from '../../../redis/redis.module';
import { OTP_SENDER } from './otp-sender.interface';

describe('OtpService', () => {
  let service: OtpService;

  // Objeto falso de Redis: solo implementa los métodos que
  // OtpService realmente usa (get, set). jest.fn() crea una
  // función "espía" que registra cómo la llamaron.
  const mockRedis = {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
  };

  // Objeto falso del sender: no manda correos de verdad.
  const mockOtpSender = {
    send: jest.fn(),
  };

  beforeEach(async () => {
    // Se ejecuta ANTES de cada prueba individual — deja todo limpio,
    // para que una prueba no contamine a la siguiente.
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OtpService,
        { provide: REDIS_CLIENT, useValue: mockRedis },
        { provide: OTP_SENDER, useValue: mockOtpSender },
      ],
    }).compile();

    service = module.get<OtpService>(OtpService);
  });

  describe('requestOtp', () => {
    it('genera un código, lo guarda en Redis, y lo envía', async () => {
      mockRedis.get.mockResolvedValue(null); // sin cooldown activo

      await service.requestOtp('test@example.com');

      // Verifica que SÍ se guardó un código en Redis con expiración
      expect(mockRedis.set).toHaveBeenCalledWith(
        'otp:code:test@example.com',
        expect.any(String),
        'EX',
        300,
      );
      // Verifica que SÍ se llamó al sender
      expect(mockOtpSender.send).toHaveBeenCalledWith(
        'test@example.com',
        expect.any(String),
      );
    });

    it('rechaza si hay un cooldown activo', async () => {
      mockRedis.get.mockResolvedValue('1'); // simula cooldown vigente

      await expect(service.requestOtp('test@example.com')).rejects.toThrow(
        BadRequestException,
      );

      // Y confirma que, al rechazar, NUNCA llegó a mandar el correo
      expect(mockOtpSender.send).not.toHaveBeenCalled();
    });
  });

  describe('verifyOtp', () => {
    it('devuelve true y borra el código si coincide', async () => {
      mockRedis.get.mockResolvedValue('123456');

      const result = await service.verifyOtp('test@example.com', '123456');

      expect(result).toBe(true);
      expect(mockRedis.del).toHaveBeenCalledWith('otp:code:test@example.com');
    });

    it('devuelve false si el código no coincide', async () => {
      mockRedis.get.mockResolvedValue('999999');

      const result = await service.verifyOtp('test@example.com', '123456');

      expect(result).toBe(false);
      // Un código incorrecto NO debe borrarse — alguien podría
      // seguir intentando con el correcto antes de que expire solo
      expect(mockRedis.del).not.toHaveBeenCalled();
    });

    it('devuelve false si no hay ningún código guardado (expiró o nunca existió)', async () => {
      mockRedis.get.mockResolvedValue(null);

      const result = await service.verifyOtp('test@example.com', '123456');

      expect(result).toBe(false);
    });
  });
});
