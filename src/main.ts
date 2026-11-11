import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/errors/http-exception.filter';

async function bootstrap(): Promise<void> {
  // rawBody: keep the exact bytes so WhatsApp signatures can be checked.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.useGlobalFilters(new HttpExceptionFilter(app.get(HttpAdapterHost)));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableShutdownHooks();
  await app.listen(app.get(ConfigService).get<number>('PORT', 3000));
}

void bootstrap().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});