// ㉿ Fiação da aplicação: liga portas, adaptadores, use cases e workers.
import { MikroORM } from '@mikro-orm/postgresql';
import {
  type BeforeApplicationShutdown,
  type DynamicModule,
  Inject,
  Injectable,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type Provider,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import {
  PROVIDER_IDENTITY_PORT,
  ProviderAuthGuard,
  type ProviderIdentityPort,
  TrustAllProviderIdentity,
} from './auth/provider-auth.guard';
import { APP_CONFIG, type AppConfig } from './config/app-config';
import { HealthController } from './observability/health.controller';
import { LifecycleState } from './observability/lifecycle-state';
import { AppLogger } from './observability/logger';
import { Metrics } from './observability/metrics';
import { ExponentialBackoff } from './shared/domain/backoff';
import { ConfigurableFaultInjector } from './shared/infrastructure/fault-injector';
import { CreateWallet } from './wagering/application/create-wallet';
import {
  CLOCK,
  type Clock,
  FAULT_INJECTOR,
  type FaultInjector,
  OUTBOX_REPOSITORY,
  type OutboxRepository,
  TELEMETRY,
  UNIT_OF_WORK,
  type UnitOfWork,
} from './wagering/application/ports';
import { ProcessWagerTransaction } from './wagering/application/process-wager-transaction';
import { ReconcileWallet } from './wagering/application/reconcile-wallet';
import { RecordProcessingFailure } from './wagering/application/record-processing-failure';
import { ResolvePendingReferences } from './wagering/application/resolve-pending-references';
import { WageringQueries } from './wagering/application/wagering-queries';
import { OutboxPublisher } from './wagering/infrastructure/messaging/outbox-publisher';
import { SqsGateway } from './wagering/infrastructure/messaging/sqs-gateway';
import { WagerTransactionConsumer } from './wagering/infrastructure/messaging/wager-transaction-consumer';
import { createOrmConfig } from './wagering/infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from './wagering/infrastructure/persistence/mikro-orm-unit-of-work';
import { MikroOrmOutboxRepository } from './wagering/infrastructure/persistence/repositories';
import { PendingReferenceWorker } from './wagering/infrastructure/workers/pending-reference-worker';
import { HttpErrorFilter } from './wagering/interfaces/http/http-error.filter';
import {
  CREATE_WALLET,
  METRICS,
  MIKRO_ORM,
  PROCESS_WAGER,
  RECONCILE_WALLET,
  RECORD_PROCESSING_FAILURE,
  RESOLVE_PENDING_REFERENCES,
  SQS_GATEWAY,
  WAGERING_QUERIES,
} from './wagering/interfaces/http/tokens';
import { WageringController } from './wagering/interfaces/http/wagering.controller';
import { WalletsController } from './wagering/interfaces/http/wallets.controller';

export interface AppOverrides {
  faultInjector?: FaultInjector;
  clock?: Clock;
  providerIdentity?: ProviderIdentityPort;
}

/** Sobe os papéis em background desta instância e para tudo com calma no shutdown. */
@Injectable()
class RuntimeLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly logger = new AppLogger('RuntimeLifecycle');

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(MIKRO_ORM) private readonly orm: MikroORM,
    @Inject(SQS_GATEWAY) private readonly sqs: SqsGateway,
    private readonly consumer: WagerTransactionConsumer,
    private readonly publisher: OutboxPublisher,
    private readonly pendingReferences: PendingReferenceWorker,
    private readonly lifecycle: LifecycleState,
  ) {}

  onApplicationBootstrap(): void {
    const roles = this.config.roles;
    if (roles.has('consumer')) this.consumer.start();
    if (roles.has('outbox')) this.publisher.start();
    if (roles.has('pending-references')) this.pendingReferences.start();
    this.logger.info('instance started', { roles: [...roles] });
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.lifecycle.shuttingDown = true;
    this.logger.info('shutting down', { signal });
    await Promise.all([this.consumer.stop(), this.publisher.stop(), this.pendingReferences.stop()]);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close(true);
    this.sqs.close();
    this.logger.info('shutdown complete');
  }
}

@Module({})
export class AppModule {
  static forRoot(config: AppConfig, overrides: AppOverrides = {}): DynamicModule {
    const providers: Provider[] = [
      { provide: APP_CONFIG, useValue: config },
      LifecycleState,
      { provide: METRICS, useValue: new Metrics() },
      { provide: TELEMETRY, useExisting: METRICS },
      { provide: CLOCK, useValue: overrides.clock ?? { now: () => new Date() } },
      { provide: FAULT_INJECTOR, useValue: overrides.faultInjector ?? new ConfigurableFaultInjector(config.faultInjection) },
      { provide: PROVIDER_IDENTITY_PORT, useValue: overrides.providerIdentity ?? new TrustAllProviderIdentity() },
      ProviderAuthGuard,
      {
        provide: MIKRO_ORM,
        useFactory: () =>
          MikroORM.init(
            createOrmConfig({ url: config.database.url, poolMin: config.database.poolMin, poolMax: config.database.poolMax }),
          ),
      },
      { provide: SQS_GATEWAY, useFactory: () => new SqsGateway(config) },
      {
        provide: UNIT_OF_WORK,
        inject: [MIKRO_ORM],
        useFactory: (orm: MikroORM) =>
          new MikroOrmUnitOfWork(orm, {
            lockTimeoutMs: config.database.lockTimeoutMs,
            statementTimeoutMs: config.database.statementTimeoutMs,
          }),
      },
      {
        provide: OUTBOX_REPOSITORY,
        inject: [MIKRO_ORM],
        useFactory: (orm: MikroORM) => new MikroOrmOutboxRepository(orm.em.fork()),
      },
      {
        provide: PROCESS_WAGER,
        inject: [UNIT_OF_WORK, CLOCK, TELEMETRY, FAULT_INJECTOR],
        useFactory: (uow: UnitOfWork, clock: Clock, telemetry: Metrics, faults: FaultInjector) =>
          new ProcessWagerTransaction(
            uow,
            clock,
            telemetry,
            faults,
            new ExponentialBackoff(config.pendingReferences.backoffBaseMs, config.pendingReferences.backoffMaxMs),
          ),
      },
      {
        provide: CREATE_WALLET,
        inject: [UNIT_OF_WORK, CLOCK],
        useFactory: (uow: UnitOfWork, clock: Clock) => new CreateWallet(uow, clock),
      },
      {
        provide: RECONCILE_WALLET,
        inject: [UNIT_OF_WORK, CLOCK, TELEMETRY],
        useFactory: (uow: UnitOfWork, clock: Clock, telemetry: Metrics) => new ReconcileWallet(uow, clock, telemetry),
      },
      { provide: WAGERING_QUERIES, inject: [UNIT_OF_WORK], useFactory: (uow: UnitOfWork) => new WageringQueries(uow) },
      {
        provide: RESOLVE_PENDING_REFERENCES,
        inject: [UNIT_OF_WORK, CLOCK, TELEMETRY],
        useFactory: (uow: UnitOfWork, clock: Clock, telemetry: Metrics) =>
          new ResolvePendingReferences(uow, clock, telemetry, {
            backoff: new ExponentialBackoff(config.pendingReferences.backoffBaseMs, config.pendingReferences.backoffMaxMs),
            maxAttempts: config.pendingReferences.maxAttempts,
          }),
      },
      {
        provide: RECORD_PROCESSING_FAILURE,
        inject: [UNIT_OF_WORK, CLOCK, TELEMETRY],
        useFactory: (uow: UnitOfWork, clock: Clock, telemetry: Metrics) =>
          new RecordProcessingFailure(uow, clock, telemetry),
      },
      {
        provide: WagerTransactionConsumer,
        inject: [SQS_GATEWAY, PROCESS_WAGER, RECORD_PROCESSING_FAILURE, METRICS, FAULT_INJECTOR],
        useFactory: (
          sqs: SqsGateway,
          processWager: ProcessWagerTransaction,
          recordFailure: RecordProcessingFailure,
          metrics: Metrics,
          faults: FaultInjector,
        ) => new WagerTransactionConsumer(config, sqs, processWager, recordFailure, metrics, faults),
      },
      {
        provide: OutboxPublisher,
        inject: [OUTBOX_REPOSITORY, SQS_GATEWAY, METRICS, FAULT_INJECTOR],
        useFactory: (outbox: OutboxRepository, sqs: SqsGateway, metrics: Metrics, faults: FaultInjector) =>
          new OutboxPublisher(config, outbox, sqs, metrics, faults),
      },
      {
        provide: PendingReferenceWorker,
        inject: [RESOLVE_PENDING_REFERENCES, METRICS],
        useFactory: (resolver: ResolvePendingReferences, metrics: Metrics) =>
          new PendingReferenceWorker(config, resolver, metrics),
      },
      { provide: APP_FILTER, inject: [METRICS], useFactory: (metrics: Metrics) => new HttpErrorFilter(metrics) },
      RuntimeLifecycle,
    ];

    return {
      module: AppModule,
      controllers: config.roles.has('api') ? [WalletsController, WageringController, HealthController] : [HealthController],
      providers,
    };
  }
}
