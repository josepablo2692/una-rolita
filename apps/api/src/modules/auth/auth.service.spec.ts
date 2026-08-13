// apps/api/src/modules/auth/auth.service.spec.ts
//
// ROADMAP — Épica 7, deuda técnica de pruebas. Prueba loginStaff de
// forma AISLADA: OtpService y RefreshTokenService están mockeados
// (ya se probaron por separado), igual que los Repository de TypeORM.
// Esta prueba solo verifica la LÓGICA de orquestación de AuthService.

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';
import { TableSession } from './entities/table-session.entity';
import { VenueTable } from '../venues/entities/venue-table.entity';
import { User } from './entities/user.entity';
import { UserVenueRole } from './entities/user-venue-role.entity';
import { Role } from './entities/role.entity';
import { OtpService } from './otp/otp.service';
import { RefreshTokenService } from './jwt/refresh-token.service';

describe('AuthService', () => {
  let service: AuthService;

  // Un usuario "de utilería" con contraseña ya hasheada de verdad,
  // para que bcrypt.compare() tenga algo real contra qué comparar.
  const passwordReal = 'MiClave123';
  let hashReal: string;

  const mockUserRepository = {
    findOne: jest.fn(),
  };
  const mockUserVenueRoleRepository = {
    findOne: jest.fn(),
  };
  const mockRoleRepository = {
    findOne: jest.fn(),
  };
  const mockRefreshTokenService = {
    generate: jest.fn().mockResolvedValue('fake-refresh-token'),
  };
  const mockJwtService = {
    sign: jest.fn().mockReturnValue('fake-access-token'),
  };

  beforeAll(async () => {
    hashReal = await bcrypt.hash(passwordReal, 10);
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    mockRefreshTokenService.generate.mockResolvedValue('fake-refresh-token');
    mockJwtService.sign.mockReturnValue('fake-access-token');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: getRepositoryToken(TableSession), useValue: {} },
        { provide: getRepositoryToken(VenueTable), useValue: {} },
        { provide: getRepositoryToken(User), useValue: mockUserRepository },
        {
          provide: getRepositoryToken(UserVenueRole),
          useValue: mockUserVenueRoleRepository,
        },
        { provide: getRepositoryToken(Role), useValue: mockRoleRepository },
        { provide: OtpService, useValue: {} },
        { provide: JwtService, useValue: mockJwtService },
        { provide: RefreshTokenService, useValue: mockRefreshTokenService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  describe('loginStaff', () => {
    it('rechaza si el usuario no existe', async () => {
      mockUserRepository.findOne.mockResolvedValue(null);

      await expect(
        service.loginStaff({ email: 'nadie@example.com', password: 'x' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rechaza si el usuario existe pero NO tiene password_hash (es cliente, no staff)', async () => {
      mockUserRepository.findOne.mockResolvedValue({
        id: 'user-1',
        email: 'cliente@example.com',
        passwordHash: null,
      });

      await expect(
        service.loginStaff({ email: 'cliente@example.com', password: 'x' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rechaza si la contraseña no coincide', async () => {
      mockUserRepository.findOne.mockResolvedValue({
        id: 'user-2',
        email: 'admin@example.com',
        passwordHash: hashReal,
      });

      await expect(
        service.loginStaff({
          email: 'admin@example.com',
          password: 'ContraseñaIncorrecta',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rechaza si tiene contraseña correcta pero SIN rol asignado en ningún venue', async () => {
      mockUserRepository.findOne.mockResolvedValue({
        id: 'user-3',
        email: 'admin@example.com',
        passwordHash: hashReal,
      });
      mockUserVenueRoleRepository.findOne.mockResolvedValue(null);

      await expect(
        service.loginStaff({
          email: 'admin@example.com',
          password: passwordReal,
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('login exitoso: firma el JWT con el role REAL, no un valor fijo', async () => {
      mockUserRepository.findOne.mockResolvedValue({
        id: 'user-4',
        email: 'admin@example.com',
        passwordHash: hashReal,
      });
      mockUserVenueRoleRepository.findOne.mockResolvedValue({
        userId: 'user-4',
        venueId: 'venue-1',
        roleId: 2,
      });
      mockRoleRepository.findOne.mockResolvedValue({
        id: 2,
        name: 'venue_admin',
      });

      const result = await service.loginStaff({
        email: 'admin@example.com',
        password: passwordReal,
      });

      // La prueba más importante de todas: confirma que el payload
      // firmado trae el role REAL resuelto ('venue_admin'), no un
      // valor hardcodeado como pasa en upgradeGuestToUser.
      expect(mockJwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          sub: 'user-4',
          role: 'venue_admin',
          venueId: 'venue-1',
        }),
      );
      expect(result.accessToken).toBe('fake-access-token');
      expect(result.refreshToken).toBe('fake-refresh-token');
      // Confirma que passwordHash NUNCA sale en la respuesta —
      // la misma corrección de seguridad que aplicaste hace unas noches.
      expect(result.user).not.toHaveProperty('passwordHash');
    });
  });
});
