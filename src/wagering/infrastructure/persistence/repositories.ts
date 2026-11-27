import { type EntityManager, LockMode } from '@mikro-orm/postgresql';
import { Money } from '../../../shared/domain/money';
import { ConcurrencyConflictError, WalletAlreadyExistsError } from '../../application/errors';
import type {
  InboxRepository,
  LedgerPageQuery,
  LedgerRepository,
  LedgerSummary,
  OutboxRepository,
  OutboxStats,
  TransactionScope,
  WagerTransactionRepository,
  WalletRepository,
} from '../../application/ports';
import type { InboxMessage } from '../../domain/inbox-message';
import type { OutboxMessage } from '../../domain/outbox-message';
import { type WagerTransaction, WagerTransactionStatus } from '../../domain/wager-transaction';
import type { Wallet } from '../../domain/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import {
  InboxMapper,
  LedgerEntryMapper,
  OutboxMapper,
  WagerTransactionMapper,
  WalletMapper,
} from './mappers';
import { isUniqueViolation } from './pg-errors';
import {
  InboxSchema,
  LedgerEntrySchema,
  type OutboxRecord,
  OutboxSchema,
  WagerTransactionSchema,
  WalletSchema,
} from './schemas';

/*
 * Os repositórios são adaptadores finos sobre um fork do EntityManager. Dentro de uma unidade
 * de trabalho o fork está preso à transação SQL, então todo statement abaixo participa dela.
 *
 * Leituras usam o ORM (find/findOne, LockMode). As escritas cuja semântica É o mecanismo de
 * correção (ON CONFLICT DO NOTHING, UPDATE condicional, leases com SKIP LOCKED) são statements
 * explícitos executados na hora, na ordem do código — em vez de ficarem para um flush —
 * para a ordem de locks e inserts ficar visível no código que depende dela.
 */

export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | null> {
    const record = await this.em.findOne(WalletSchema, { id }, { refresh: true });
    return record ? WalletMapper.toDomain(record) : null;
  }

  async lockById(id: string): Promise<Wallet | null> {
    const record = await this.em.findOne(
      WalletSchema,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
    );
    return record ? WalletMapper.toDomain(record) : null;
  }

  async insert(wallet: Wallet): Promise<void> {
    try {
      await this.em.insert(WalletSchema, WalletMapper.toRecord(wallet));
    } catch (error) {
      if (isUniqueViolation(error, 'wallets_player_currency_uq')) {
        throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency);
      }
      throw error;
    }
  }

  async saveBalance(wallet: Wallet, expectedVersion: number): Promise<void> {
    const affected = await this.em.nativeUpdate(
      WalletSchema,
      { id: wallet.id, version: expectedVersion },
      { balance: wallet.balance.amount, version: wallet.version, updatedAt: wallet.updatedAt },
    );
    if (affected !== 1) {
      throw new ConcurrencyConflictError(`Wallet ${wallet.id} changed concurrently (expected v${expectedVersion})`);
    }
  }
}

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | null> {
    const record = await this.em.findOne(WagerTransactionSchema, { id }, { refresh: true });
    return record ? WagerTransactionMapper.toDomain(record) : null;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | null> {
    const record = await this.em.findOne(WagerTransactionSchema, { idempotencyKey }, { refresh: true });
    return record ? WagerTransactionMapper.toDomain(record) : null;
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
    const record = await this.em.findOne(
      WagerTransactionSchema,
      { providerId, externalTransactionId },
      { refresh: true },
    );
    return record ? WagerTransactionMapper.toDomain(record) : null;
  }

  async insertIfAbsent(tx: WagerTransaction): Promise<boolean> {
    const r = WagerTransactionMapper.toRecord(tx, tx.processedAt ?? tx.createdAt);
    // ON CONFLICT sem alvo cobre as duas chaves únicas (idempotency_key e provider+external id).
    // Se uma transação concorrente tem uma linha ainda não commitada com a mesma chave, o Postgres
    // espera ela terminar e então reporta o conflito — não sobra janela de corrida.
    const rows = await this.em.execute<Array<{ id: string }>>(
      `INSERT INTO wager_transactions (
         id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
         round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id,
         status, failure_code, resulting_balance, reference_attempts, next_reference_attempt_at,
         created_at, processed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        r.id, r.providerId, r.externalTransactionId, r.idempotencyKey, r.payloadHash, r.walletId, r.playerId,
        r.roundId, r.gameId, r.kind, r.amount, r.currency, r.referenceExternalTransactionId, r.referenceTransactionId,
        r.status, r.failureCode, r.resultingBalance, r.referenceAttempts, r.nextReferenceAttemptAt,
        r.createdAt, r.processedAt, r.updatedAt,
      ],
    );
    return rows.length === 1;
  }

  async update(tx: WagerTransaction, expectedStatus: WagerTransactionStatus): Promise<void> {
    const r = WagerTransactionMapper.toRecord(tx, new Date());
    const affected = await this.em.nativeUpdate(
      WagerTransactionSchema,
      { id: tx.id, status: expectedStatus },
      {
        status: r.status,
        referenceTransactionId: r.referenceTransactionId,
        failureCode: r.failureCode,
        resultingBalance: r.resultingBalance,
        referenceAttempts: r.referenceAttempts,
        nextReferenceAttemptAt: r.nextReferenceAttemptAt,
        processedAt: r.processedAt,
        updatedAt: r.updatedAt,
      },
    );
    if (affected !== 1) {
      throw new ConcurrencyConflictError(`Transaction ${tx.id} is no longer ${expectedStatus}`);
    }
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionSchema, {
      referenceTransactionId,
      status: WagerTransactionStatus.Processed,
      kind: { $in: ['REFUND', 'ROLLBACK'] },
    });
    return count > 0;
  }

  async findDuePendingReferences(now: Date, limit: number): Promise<Array<{ id: string; walletId: string }>> {
    const records = await this.em.find(
      WagerTransactionSchema,
      { status: WagerTransactionStatus.PendingReference, nextReferenceAttemptAt: { $lte: now } },
      { orderBy: { nextReferenceAttemptAt: 'ASC' }, limit, fields: ['id', 'walletId'], disableIdentityMap: true },
    );
    return records.map((r) => ({ id: r.id, walletId: r.walletId }));
  }

  async nudgePendingDependents(providerId: string, externalTransactionId: string, now: Date): Promise<number> {
    return this.em.nativeUpdate(
      WagerTransactionSchema,
      {
        providerId,
        referenceExternalTransactionId: externalTransactionId,
        status: WagerTransactionStatus.PendingReference,
        nextReferenceAttemptAt: { $gt: now },
      },
      { nextReferenceAttemptAt: now, updatedAt: now },
    );
  }

  async countByStatus(): Promise<Record<string, number>> {
    const rows = await this.em.execute<Array<{ status: string; count: string }>>(
      'SELECT status, count(*)::text AS count FROM wager_transactions GROUP BY status',
    );
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.count)]));
  }
}

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntrySchema, LedgerEntryMapper.toRecord(entry));
  }

  async page(query: LedgerPageQuery): Promise<WalletLedgerEntry[]> {
    const records = await this.em.find(
      LedgerEntrySchema,
      {
        walletId: query.walletId,
        ...(query.beforeVersion !== undefined ? { walletVersion: { $lt: query.beforeVersion } } : {}),
      },
      { orderBy: { walletVersion: 'DESC' }, limit: query.limit, disableIdentityMap: true },
    );
    return records.map((r) => LedgerEntryMapper.toDomain(r));
  }

  async summarize(walletId: string, currency: string): Promise<LedgerSummary> {
    const [row] = await this.em.execute<
      Array<{ entries: string; net: string; last_version: number | null; last_balance: string | null }>
    >(
      `SELECT count(*)::text AS entries,
              COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::numeric(20,2)::text AS net,
              MAX(wallet_version) AS last_version,
              (SELECT balance_after::text FROM wallet_ledger_entries
                WHERE wallet_id = ? ORDER BY wallet_version DESC LIMIT 1) AS last_balance
         FROM wallet_ledger_entries
        WHERE wallet_id = ?`,
      [walletId, walletId],
    );
    return {
      entries: Number(row?.entries ?? 0),
      net: Money.fromSigned({ amount: row?.net ?? '0.00', currency }),
      lastVersion: row?.last_version ?? undefined,
      lastBalanceAfter: row?.last_balance ? Money.from({ amount: row.last_balance, currency }) : undefined,
    };
  }
}

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async tryInsert(message: InboxMessage): Promise<boolean> {
    const rows = await this.em.execute<Array<{ message_id: string }>>(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING message_id`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt],
    );
    return rows.length === 1;
  }

  async find(consumerName: string, messageId: string): Promise<InboxMessage | null> {
    const record = await this.em.findOne(InboxSchema, { consumerName, messageId }, { refresh: true });
    return record ? InboxMapper.toDomain(record) : null;
  }

  async markProcessed(message: InboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      InboxSchema,
      { consumerName: message.consumerName, messageId: message.messageId },
      { processedAt: message.processedAt ?? new Date() },
    );
  }
}

interface RawOutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown> | string;
  occurred_at: Date | string;
  attempts: number;
  next_attempt_at: Date | string;
  published_at: Date | string | null;
  lease_owner: string | null;
  lease_expires_at: Date | string | null;
  last_error: string | null;
}

/** Statements crus pulam o hidratador do ORM, que configura o driver para devolver timestamps como string. */
const toDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));
const toDateOrNull = (value: Date | string | null): Date | null => (value === null ? null : toDate(value));

function outboxFromRow(row: RawOutboxRow): OutboxMessage {
  const record: OutboxRecord = {
    id: row.id,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: typeof row.payload === 'string' ? (JSON.parse(row.payload) as Record<string, unknown>) : row.payload,
    occurredAt: toDate(row.occurred_at),
    attempts: row.attempts,
    nextAttemptAt: toDate(row.next_attempt_at),
    publishedAt: toDateOrNull(row.published_at),
    leaseOwner: row.lease_owner,
    leaseExpiresAt: toDateOrNull(row.lease_expires_at),
    lastError: row.last_error,
  };
  return OutboxMapper.toDomain(record);
}

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async enqueue(messages: OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.em.insertMany(
      OutboxSchema,
      messages.map((m) => ({
        id: m.id,
        aggregateId: m.aggregateId,
        eventType: m.eventType,
        // O ORM normaliza os parâmetros no próprio objeto; o payload do domínio é congelado, então passo uma cópia.
        payload: structuredClone(m.payload) as Record<string, unknown>,
        occurredAt: m.occurredAt,
        attempts: m.attempts,
        nextAttemptAt: m.nextAttemptAt ?? m.occurredAt,
        publishedAt: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: null,
      })),
    );
  }

  async claimDue(owner: string, leaseMs: number, limit: number): Promise<OutboxMessage[]> {
    // Um único statement = a própria transação. SKIP LOCKED faz publishers concorrentes pegarem
    // linhas diferentes; a lease (e não uma transação aberta) protege a linha durante a chamada
    // de rede, e expira se o publisher morrer, deixando outra instância assumir.
    const rows = await this.em.execute<RawOutboxRow[]>(
      `UPDATE outbox_messages o
          SET lease_owner = ?, lease_expires_at = now() + (? * interval '1 millisecond')
        WHERE o.id IN (
          SELECT id FROM outbox_messages
           WHERE published_at IS NULL
             AND next_attempt_at <= now()
             AND (lease_expires_at IS NULL OR lease_expires_at < now())
           ORDER BY occurred_at, id
           LIMIT ?
           FOR UPDATE SKIP LOCKED)
        RETURNING o.*`,
      [owner, leaseMs, limit],
    );
    return rows
      .map(outboxFromRow)
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id));
  }

  async markPublished(messages: OutboxMessage[], owner: string): Promise<number> {
    if (messages.length === 0) return 0;
    const result = await this.em.execute<{ affectedRows: number }>(
      `UPDATE outbox_messages
          SET published_at = now(), attempts = attempts + 1, lease_owner = NULL, lease_expires_at = NULL, last_error = NULL
        WHERE id IN (?) AND lease_owner = ? AND published_at IS NULL`,
      [messages.map((m) => m.id), owner],
      'run',
    );
    return result.affectedRows;
  }

  async reschedule(message: OutboxMessage, owner: string, error: string): Promise<void> {
    await this.em.nativeUpdate(
      OutboxSchema,
      { id: message.id, leaseOwner: owner, publishedAt: null },
      {
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt ?? new Date(),
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: error.slice(0, 1024),
      },
    );
  }

  async releaseLeases(owner: string): Promise<number> {
    return this.em.nativeUpdate(
      OutboxSchema,
      { leaseOwner: owner, publishedAt: null },
      { leaseOwner: null, leaseExpiresAt: null },
    );
  }

  async stats(): Promise<OutboxStats> {
    const [row] = await this.em.execute<Array<{ pending: string; oldest_age: string | null }>>(
      `SELECT count(*)::text AS pending,
              EXTRACT(EPOCH FROM (now() - MIN(occurred_at)))::text AS oldest_age
         FROM outbox_messages
        WHERE published_at IS NULL`,
    );
    return {
      pending: Number(row?.pending ?? 0),
      oldestPendingAgeSeconds: row?.oldest_age ? Math.max(0, Number(row.oldest_age)) : 0,
    };
  }
}

export function createTransactionScope(em: EntityManager): TransactionScope {
  return {
    wallets: new MikroOrmWalletRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    inbox: new MikroOrmInboxRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
  };
}
