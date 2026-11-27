import { IsolationLevel, type MikroORM } from '@mikro-orm/postgresql';
import type { TransactionScope, UnitOfWork, UnitOfWorkOptions } from '../../application/ports';
import { translatePersistenceError } from './pg-errors';
import { createTransactionScope } from './repositories';

/**
 * Um `EntityManager.transactional()` por unidade de trabalho, num fork novo (identity map limpo).
 * Toda unidade de trabalho define um lock_timeout local, para um lock preso virar um erro rápido
 * e repetível em vez de uma espera sem fim, e um statement_timeout como garantia extra.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly timeouts: { lockTimeoutMs: number; statementTimeoutMs: number },
  ) {}

  async run<T>(work: (scope: TransactionScope) => Promise<T>, options: UnitOfWorkOptions = {}): Promise<T> {
    try {
      return await this.orm.em.fork({ clear: true }).transactional(
        async (em) => {
          await em.execute(
            `SELECT set_config('lock_timeout', ?, true), set_config('statement_timeout', ?, true)`,
            [`${this.timeouts.lockTimeoutMs}ms`, `${this.timeouts.statementTimeoutMs}ms`],
          );
          return work(createTransactionScope(em));
        },
        {
          isolationLevel:
            options.isolation === 'repeatable_read' ? IsolationLevel.REPEATABLE_READ : IsolationLevel.READ_COMMITTED,
          readOnly: options.readOnly,
        },
      );
    } catch (error) {
      throw translatePersistenceError(error);
    }
  }
}
