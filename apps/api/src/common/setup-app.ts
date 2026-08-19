// apps/api/src/common/setup-app.ts
//
// Configuración global de la aplicación, en UN solo lugar.
//
// Por qué existe: `main.ts` no participa en las pruebas. Las pruebas e2e
// arman la app con Test.createTestingModule({ imports: [AppModule] }), y
// eso NO incluye nada de lo que se registra en main.ts. Sin extraer esto,
// el entorno de prueba no tendría ValidationPipe y sería más permisivo
// que producción: las pruebas pasarían en verde mientras el servidor real
// se comporta distinto. Una prueba que miente es peor que no tenerla.
//
// Todo lo global que agreguemos después (exception filters, interceptores)
// va aquí, no en main.ts.

import {
  INestApplication,
  ValidationPipe,
  BadRequestException,
} from '@nestjs/common';

export function setupApp(app: INestApplication): INestApplication {
  app.useGlobalPipes(
    new ValidationPipe({
      // Descarta cualquier propiedad del body que NO esté declarada con un
      // decorador en el DTO. Cierra mass assignment.
      whitelist: true,

      // En vez de descartar en silencio, responde 400 diciendo qué sobra.
      forbidNonWhitelisted: true,

      // Convierte el JSON plano en una instancia real de la clase DTO.
      transform: true,

      // Conversión implícita APAGADA: con ella, "abc" en un campo numérico
      // se vuelve NaN en silencio.
      transformOptions: { enableImplicitConversion: false },

      // No devolver el objeto recibido en el error: evita reflejarle al
      // cliente datos que él mismo mandó, incluidos los que descartamos.
      validationError: { target: false, value: false },

      // class-validator genera sus mensajes en inglés. Traducimos el del
      // whitelist, que es el único que produce el pipe y no el decorador.
      exceptionFactory: (errors) => {
        const mensajes = errors.flatMap((e) =>
          Object.values(e.constraints ?? {}).map((m) =>
            m.startsWith('property ') && m.endsWith('should not exist')
              ? `El campo "${e.property}" no está permitido`
              : m,
          ),
        );
        return new BadRequestException({
          statusCode: 400,
          error: 'Solicitud inválida',
          message: mensajes,
        });
      },
    }),
  );

  return app;
}
