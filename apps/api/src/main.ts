import { NestFactory } from '@nestjs/core';
import { ValidationPipe, BadRequestException } from '@nestjs/common';
import { AppModule } from './app.module';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // ------------------------------------------------------------
  // ValidationPipe GLOBAL. Sin esto, los decoradores de
  // class-validator (@IsString, @MaxLength, etc.) de TODOS los DTOs
  // del proyecto no se ejecutan nunca — son solo anotaciones.
  // ------------------------------------------------------------
  // apps/api/src/main.ts
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      // Traduce el mensaje de propiedades no permitidas, que el pipe
      // genera internamente en inglés.
      validationError: { target: false, value: false },
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
  const config = new DocumentBuilder()
    .setTitle('Una Rolita API')
    .setDescription('API de la rocola digital para bares, gimnasios y clubes')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
