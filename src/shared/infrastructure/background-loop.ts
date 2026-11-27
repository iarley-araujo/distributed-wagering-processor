import { AppLogger } from '../../observability/logger';

/**
 * Loop cooperativo simples para os workers: `stop()` deixa a iteração atual terminar
 * (com limite de tempo) e interrompe na hora a espera ociosa.
 */
export class BackgroundLoop {
  private running = false;
  private current: Promise<void> = Promise.resolve();
  private wake: (() => void) | undefined;
  private readonly logger: AppLogger;

  constructor(
    private readonly name: string,
    private readonly iteration: () => Promise<number>,
    private readonly idleMs: number,
    private readonly errorBackoffMs: number = 1_000,
  ) {
    this.logger = new AppLogger(name);
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.current = this.run();
    this.logger.info('background loop started');
  }

  async stop(graceMs: number): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.wake?.();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.current, new Promise<void>((resolve) => (timer = setTimeout(resolve, graceMs)))]);
    clearTimeout(timer);
    this.logger.info('background loop stopped');
  }

  private async run(): Promise<void> {
    while (this.running) {
      let delay = this.idleMs;
      try {
        const worked = await this.iteration();
        // Enquanto tiver trabalho, drena o backlog sem dormir.
        if (worked > 0) delay = 0;
      } catch (error) {
        this.logger.error('background iteration failed', { error });
        delay = this.errorBackoffMs;
      }
      if (this.running && delay > 0) await this.sleep(delay);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = undefined;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
    });
  }
}
