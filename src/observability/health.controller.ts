import { Controller, Get, Header, Inject, Res } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import type { SqsGateway } from '../wagering/infrastructure/messaging/sqs-gateway';
import { METRICS, MIKRO_ORM, SQS_GATEWAY } from '../wagering/interfaces/http/tokens';
import type { Metrics } from './metrics';
import { LifecycleState } from './lifecycle-state';

async function check(name: string, probe: () => Promise<unknown>, timeoutMs = 2_000) {
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      probe(),
      new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('timeout')), timeoutMs))),
    ]);
    return { name, status: 'up' as const, latencyMs: Math.round(performance.now() - started) };
  } catch (error) {
    return { name, status: 'down' as const, error: (error as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/** Sem autenticação de propósito: probes de liveness/readiness e scrape do Prometheus. */
@Controller()
export class HealthController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(MIKRO_ORM) private readonly orm: MikroORM,
    @Inject(SQS_GATEWAY) private readonly sqs: SqsGateway,
    @Inject(METRICS) private readonly metrics: Metrics,
    private readonly lifecycle: LifecycleState,
  ) {}

  /** Processo vivo e event loop respondendo. Não checa dependências (evita restart em cascata). */
  @Get('health/live')
  live() {
    return { status: 'ok', instanceId: this.config.instanceId, uptimeSeconds: Math.round(process.uptime()) };
  }

  /** Pronto pra receber tráfego: PostgreSQL e SQS alcançáveis e não está em shutdown. */
  @Get('health/ready')
  async ready(@Res({ passthrough: true }) response: Response) {
    const checks = await Promise.all([
      check('postgres', () => this.orm.em.fork().execute('SELECT 1')),
      check('sqs', () => this.sqs.ping(this.config.sqs.wagerQueueName)),
    ]);
    const ready = !this.lifecycle.shuttingDown && checks.every((c) => c.status === 'up');
    response.status(ready ? 200 : 503);
    return { status: ready ? 'ready' : 'not_ready', shuttingDown: this.lifecycle.shuttingDown, checks };
  }

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4')
  metricsText() {
    return this.metrics.registry.metrics();
  }
}
