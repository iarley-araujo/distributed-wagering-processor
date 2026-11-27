import type { AppConfig } from '../../../config/app-config';
import type { Metrics } from '../../../observability/metrics';
import { BackgroundLoop } from '../../../shared/infrastructure/background-loop';
import type { ResolvePendingReferences } from '../../application/resolve-pending-references';

/** Worker agendado que dirige o ResolvePendingReferences. Pode rodar em todas as instâncias. */
export class PendingReferenceWorker {
  private readonly loop: BackgroundLoop;

  constructor(
    private readonly config: AppConfig,
    private readonly resolver: ResolvePendingReferences,
    private readonly metrics: Metrics,
  ) {
    this.loop = new BackgroundLoop(
      'PendingReferenceWorker',
      () => this.runOnce(),
      config.pendingReferences.pollIntervalMs,
    );
  }

  start(): void {
    this.loop.start();
  }

  stop(): Promise<void> {
    return this.loop.stop(this.config.consumer.shutdownGraceMs);
  }

  async runOnce(): Promise<number> {
    const totals = await this.resolver.runOnce(this.config.pendingReferences.batchSize);
    for (const [result, count] of Object.entries(totals)) {
      if (count > 0) this.metrics.pendingReferenceResolutions.inc({ result }, count);
    }
    // Só conta como "trabalhou" se algo mudou de fato, assim um backlog de linhas ainda não vencidas fica ocioso.
    return totals.processed + totals.rejected;
  }
}
