import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { setupApp } from './common/setup-app';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Misma configuración que usan las pruebas e2e. Si cambia algo global,
  // cambia en setup-app.ts y ambos entornos quedan alineados solos.
  setupApp(app);

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

// `void` marca explícitamente que no esperamos la promesa — es el punto de
// entrada, no hay nadie arriba que la pueda await. Quita la advertencia de
// no-floating-promises que hoy sale en el lint.
void bootstrap();
