import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // ------------------------------------------------------------
  // Swagger / OpenAPI: genera documentación interactiva de la API,
  // navegable en /docs. Se construye leyendo los Controllers y DTOs
  // que ya existen — no hay que escribir la documentación a mano.
  // ------------------------------------------------------------
  const config = new DocumentBuilder()
    .setTitle('Una Rolita API')
    .setDescription('API de la rocola digital para bares, gimnasios y clubes')
    .setVersion('0.1.0')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
