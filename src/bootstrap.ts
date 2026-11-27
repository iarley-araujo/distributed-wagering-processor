import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule, type AppOverrides } from './app.module';
import type { AppConfig } from './config/app-config';
import { httpContextMiddleware } from './observability/http-context.middleware';
import { AppLogger, NestJsonLogger } from './observability/logger';
import type { Metrics } from './observability/metrics';
import { METRICS } from './wagering/interfaces/http/tokens';

/** Monta a aplicação inteira já ligada (usado pelo main.ts e pelos testes de integração). */
export async function createApp(config: AppConfig, overrides: AppOverrides = {}): Promise<INestApplication> {
  AppLogger.configure({ level: config.logLevel, instanceId: config.instanceId });
  const app = await NestFactory.create(AppModule.forRoot(config, overrides), {
    logger: new NestJsonLogger(),
    bufferLogs: false,
    abortOnError: false,
  });
  app.use(httpContextMiddleware(app.get<Metrics>(METRICS)));
  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
  return app;
}
