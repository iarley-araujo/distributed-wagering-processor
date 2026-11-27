import type { Money } from '../../shared/domain/money';
import { AppLogger } from '../../observability/logger';
import { WalletNotFoundError } from './errors';
import type { Clock, UnitOfWork, WageringTelemetry } from './ports';

export interface ReconciliationReport {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
  walletVersion: number;
  lastLedgerVersion: number | null;
  checkedAt: Date;
}

/**
 * Compara o saldo materializado com o saldo reconstruído pelo ledger, dentro de um
 * snapshot REPEATABLE READ (wallet e ledger vistos no mesmo instante, sem pegar lock,
 * então nunca bloqueia quem está escrevendo). Divergência é reportada, logada e contada —
 * nunca corrigida em silêncio.
 */
export class ReconcileWallet {
  private readonly logger = new AppLogger('ReconcileWallet');

  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly telemetry: WageringTelemetry,
  ) {}

  async execute(walletId: string): Promise<ReconciliationReport> {
    const report = await this.uow.run(
      async (scope) => {
        const wallet = await scope.wallets.findById(walletId);
        if (!wallet) throw new WalletNotFoundError(walletId);
        const summary = await scope.ledger.summarize(wallet.id, wallet.currency);

        const calculated = summary.net;
        const difference = wallet.balance.subtract(calculated);
        const chainHeadMatches =
          summary.lastBalanceAfter === undefined
            ? wallet.balance.isZero()
            : summary.lastBalanceAfter.equals(wallet.balance);
        const versionMatches =
          summary.lastVersion === undefined ? wallet.version === 1 : summary.lastVersion === wallet.version;

        return {
          walletId: wallet.id,
          storedBalance: wallet.balance,
          calculatedBalance: calculated,
          difference,
          consistent: difference.isZero() && chainHeadMatches && versionMatches,
          checkedEntries: summary.entries,
          walletVersion: wallet.version,
          lastLedgerVersion: summary.lastVersion ?? null,
          checkedAt: this.clock.now(),
        };
      },
      { isolation: 'repeatable_read', readOnly: true },
    );

    this.telemetry.reconciliationChecked(report.consistent);
    if (!report.consistent) {
      this.logger.error('wallet reconciliation divergence', {
        walletId,
        checkedEntries: report.checkedEntries,
        walletVersion: report.walletVersion,
        lastLedgerVersion: report.lastLedgerVersion,
        differenceIsZero: report.difference.isZero(),
      });
    }
    return report;
  }
}
