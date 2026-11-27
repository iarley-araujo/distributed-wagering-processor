import { TransientInfrastructureError } from '../../wagering/application/errors';
import type { FaultInjector, FaultPoint } from '../../wagering/application/ports';
import { AppLogger } from '../../observability/logger';

type FaultHandler = () => Promise<void> | void;

/**
 * Costura para testes. Em produção FAULT_INJECTION fica vazio, então cada `trigger` é só
 * um lookup num map sem efeito. Formato aceito (separado por vírgula):
 *   <ponto>=crash             SIGKILL no processo (sem shutdown hooks, tipo um OOM kill)
 *   <ponto>=transient:<n>     lança TransientInfrastructureError nas primeiras n vezes
 *   <ponto>=error:<n>         lança um Error genérico nas primeiras n vezes
 * Testes no mesmo processo também podem registrar handlers com `set`.
 */
export class ConfigurableFaultInjector implements FaultInjector {
  private readonly handlers = new Map<FaultPoint, FaultHandler>();
  private readonly logger = new AppLogger('FaultInjector');

  constructor(spec: string) {
    for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
      const [point, action = ''] = part.split('=') as [FaultPoint, string?];
      this.handlers.set(point, this.parse(point, action));
    }
  }

  set(point: FaultPoint, handler: FaultHandler | undefined): void {
    if (handler) this.handlers.set(point, handler);
    else this.handlers.delete(point);
  }

  async trigger(point: FaultPoint): Promise<void> {
    const handler = this.handlers.get(point);
    if (handler) await handler();
  }

  private parse(point: FaultPoint, action: string): FaultHandler {
    const [kind, countRaw] = action.split(':');
    let remaining = Number(countRaw ?? Number.POSITIVE_INFINITY);
    switch (kind) {
      case 'crash':
        return () => {
          this.logger.warn('fault injection: crashing process', { point });
          process.kill(process.pid, 'SIGKILL');
        };
      case 'transient':
        return () => {
          if (remaining-- > 0) throw new TransientInfrastructureError(`injected at ${point}`, 'injected');
        };
      case 'error':
        return () => {
          if (remaining-- > 0) throw new Error(`injected failure at ${point}`);
        };
      default:
        throw new Error(`Unknown fault action "${action}" for ${point}`);
    }
  }
}
