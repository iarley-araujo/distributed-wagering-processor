import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { SQL } from 'bun';
import { randomUUID } from 'node:crypto';
import { createOrmConfig } from '../../src/wagering/infrastructure/persistence/mikro-orm.config';
import {
  createWallet,
  ensureSchema,
  setupQueues,
  sql,
  startApp,
  submit,
  TEST_DATABASE_URL,
  testConfig,
  type TestApp,
  uniquePrefix,
  wagerBody,
} from '../support/harness';

/*
 * As invariantes da seção 6 garantidas pelo próprio banco: estes statements passam
 * totalmente por fora da aplicação e mesmo assim têm que ser recusados.
 */

let app: TestApp;
let walletId: string;
let playerId: string;
let betId: string;

beforeAll(async () => {
  await ensureSchema();
  const config = testConfig(uniquePrefix('schema'), { APP_ROLES: 'api' });
  await setupQueues(config);
  app = await startApp(config);
  ({ walletId, playerId } = await createWallet(app.url, '100.00'));
  const res = await submit(app.url, wagerBody({ walletId, playerId, kind: 'BET', amount: '10.00' }));
  expect(res.status).toBe(201);
  betId = res.body.transactionId;
});

afterAll(async () => {
  await app?.close();
});

describe('migrations', () => {
  test('are versioned and reversible (up → down → up on a fresh database)', async () => {
    const dbName = `wagering_mig_${randomUUID().slice(0, 8)}`;
    const adminUrl = TEST_DATABASE_URL.replace(/\/[^/?]+(\?|$)/, '/postgres$1');
    const admin = new SQL(adminUrl, { max: 1 });
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    const url = TEST_DATABASE_URL.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
    const orm = await MikroORM.init(createOrmConfig({ url, poolMin: 0, poolMax: 2 }));
    const db = new SQL(url, { max: 1 });
    const tables = async () =>
      ((await db`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations' ORDER BY 1`) as Array<{ tablename: string }>).map(
        (r) => r.tablename,
      );
    try {
      const migrator = orm.getMigrator();
      expect((await migrator.up()).map((m) => m.name)).toEqual([
        'Migration20261126000001_core_schema',
        'Migration20261126000002_integrity_triggers',
      ]);
      expect(await tables()).toEqual(['inbox_messages', 'outbox_messages', 'wager_transactions', 'wallet_ledger_entries', 'wallets']);

      await migrator.down(); // só os triggers
      const [triggers] = (await db`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'ledger_append_only'`) as Array<{ n: number }>;
      expect(triggers?.n).toBe(0);
      await migrator.down({ to: 0 });
      expect(await tables()).toEqual([]);

      await migrator.up();
      expect((await tables()).length).toBe(5);
    } finally {
      await db.close();
      await orm.close(true);
      await admin.unsafe(`DROP DATABASE ${dbName} WITH (FORCE)`);
      await admin.close();
    }
  });
});

describe('wallets', () => {
  test('one wallet per (player, currency)', async () => {
    await expect(
      sql`INSERT INTO wallets VALUES (${randomUUID()}, ${playerId}, 'BRL', 0, 1, now(), now())`,
    ).rejects.toThrow(/wallets_player_currency_uq/);
    // outra moeda para o mesmo player pode
    await sql`INSERT INTO wallets VALUES (${randomUUID()}, ${playerId}, 'USD', 0, 1, now(), now())`;
  });

  test('balance can never be negative', async () => {
    await expect(sql`UPDATE wallets SET balance = -0.01, version = version + 1 WHERE id = ${walletId}`).rejects.toThrow(
      /wallets_balance_non_negative_ck/,
    );
  });

  test('balance change without a ledger entry is refused at COMMIT', async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx`UPDATE wallets SET balance = balance + 1, version = version + 1 WHERE id = ${walletId}`;
      }),
    ).rejects.toThrow(/has no ledger entry/);
  });

  test('version must move by exactly one, and only with the balance', async () => {
    await expect(sql`UPDATE wallets SET balance = balance + 1 WHERE id = ${walletId}`).rejects.toThrow(/without version increment/);
    await expect(sql`UPDATE wallets SET version = version + 1 WHERE id = ${walletId}`).rejects.toThrow(/without balance change/);
    await expect(sql`UPDATE wallets SET currency = 'USD' WHERE id = ${walletId}`).rejects.toThrow(/immutable/);
  });

  test('wallets cannot be deleted', async () => {
    await expect(sql`DELETE FROM wallets WHERE id = ${walletId}`).rejects.toThrow(/forbidden/);
  });
});

describe('ledger', () => {
  test('is append-only: UPDATE, DELETE and TRUNCATE are refused', async () => {
    await expect(sql`UPDATE wallet_ledger_entries SET amount = 1 WHERE wallet_id = ${walletId}`).rejects.toThrow(/forbidden/);
    await expect(sql`DELETE FROM wallet_ledger_entries WHERE wallet_id = ${walletId}`).rejects.toThrow(/forbidden/);
    await expect(sql`TRUNCATE wallet_ledger_entries CASCADE`).rejects.toThrow(/forbidden/);
  });

  test('arithmetic is checked: balance_after = balance_before ± amount', async () => {
    await expect(
      sql`INSERT INTO wallet_ledger_entries VALUES (${randomUUID()}, ${walletId}, ${betId}, 'DEBIT', 10, 'BRL', 90, 85, 3, now())`,
    ).rejects.toThrow(/ledger_arithmetic_ck/);
  });

  test('chain must be gap-free per wallet', async () => {
    await expect(
      sql`INSERT INTO wallet_ledger_entries VALUES (${randomUUID()}, ${walletId}, ${betId}, 'DEBIT', 10, 'BRL', 50, 40, 3, now())`,
    ).rejects.toThrow(/ledger chain broken/);
  });

  test('one entry per transaction and wallet; one entry per wallet version', async () => {
    await expect(
      sql`INSERT INTO wallet_ledger_entries VALUES (${randomUUID()}, ${walletId}, ${betId}, 'DEBIT', 10, 'BRL', 90, 80, 3, now())`,
    ).rejects.toThrow(/ledger_one_entry_per_transaction_uq/);
  });

  test('an entry without the matching wallet update is refused at COMMIT', async () => {
    const [opening] = (await sql`SELECT id FROM wager_transactions WHERE wallet_id = ${walletId} AND kind = 'OPENING'`) as Array<{ id: string }>;
    await expect(
      sql.begin(async (tx) => {
        const txId = randomUUID();
        await tx`INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, processed_at, created_at, updated_at)
                 VALUES (${txId}, 'p', ${randomUUID()}, ${randomUUID()}, ${'a'.repeat(64)}, ${walletId}, ${playerId}, 'r', 'g', 'WIN', 5, 'BRL', 'PROCESSED', now(), now(), now())`;
        await tx`INSERT INTO wallet_ledger_entries VALUES (${randomUUID()}, ${walletId}, ${txId}, 'CREDIT', 5, 'BRL', 90, 95, 3, now())`;
      }),
    ).rejects.toThrow(/does not match wallet/);
    expect(opening).toBeDefined();
  });
});

describe('wager transactions', () => {
  test('idempotency key and (provider, external id) are unique', async () => {
    const [row] = (await sql`SELECT * FROM wager_transactions WHERE id = ${betId}`) as Array<Record<string, unknown>>;
    await expect(
      sql`INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, created_at, updated_at, next_reference_attempt_at)
          VALUES (${randomUUID()}, 'other', 'other', ${row?.idempotency_key as string}, ${'b'.repeat(64)}, ${walletId}, ${playerId}, 'r', 'g', 'BET', 1, 'BRL', 'PENDING', now(), now(), NULL)`,
    ).rejects.toThrow(/wager_tx_idempotency_key_uq/);
    await expect(
      sql`INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, created_at, updated_at)
          VALUES (${randomUUID()}, ${row?.provider_id as string}, ${row?.external_transaction_id as string}, ${randomUUID()}, ${'b'.repeat(64)}, ${walletId}, ${playerId}, 'r', 'g', 'BET', 1, 'BRL', 'PENDING', now(), now())`,
    ).rejects.toThrow(/wager_tx_provider_external_uq/);
  });

  test('terminal transactions are frozen and business columns immutable', async () => {
    await expect(sql`UPDATE wager_transactions SET status = 'REJECTED', failure_code = 'INSUFFICIENT_FUNDS' WHERE id = ${betId}`).rejects.toThrow(
      /terminal/,
    );
    await expect(sql`DELETE FROM wager_transactions WHERE id = ${betId}`).rejects.toThrow(/forbidden/);
  });

  test('amount must be positive, REFUND/ROLLBACK need a reference, OPENING is internal only', async () => {
    const base = (kind: string, amount: number, provider = 'p', ref: string | null = null) =>
      sql`INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, created_at, updated_at, reference_external_transaction_id)
          VALUES (${randomUUID()}, ${provider}, ${randomUUID()}, ${randomUUID()}, ${'c'.repeat(64)}, ${walletId}, ${playerId}, 'r', 'g', ${kind}, ${amount}, 'BRL', 'PENDING', now(), now(), ${ref})`;
    await expect(base('BET', 0)).rejects.toThrow(/wager_tx_amount_positive_ck/);
    await expect(base('REFUND', 1)).rejects.toThrow(/wager_tx_reference_required_ck/);
    await expect(base('OPENING', 1, 'provider-a')).rejects.toThrow(/wager_tx_opening_internal_ck/);
    await expect(base('BET', 1, '__internal__')).rejects.toThrow(/wager_tx_opening_internal_ck/);
  });

  test('a reference can be reversed at most once (partial unique index)', async () => {
    // As duas linhas numa transação só: o segundo insert falha na hora no índice único
    // (antes das checagens diferidas do ledger rodarem no commit).
    await expect(
      sql.begin(async (tx) => {
        for (const kind of ['REFUND', 'ROLLBACK']) {
          await tx`INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, created_at, updated_at, processed_at, reference_external_transaction_id, reference_transaction_id)
              VALUES (${randomUUID()}, 'provider-a', ${randomUUID()}, ${randomUUID()}, ${'d'.repeat(64)}, ${walletId}, ${playerId}, 'round-1', 'g', ${kind}, 10, 'BRL', 'PROCESSED', now(), now(), now(), 'x', ${betId})`;
        }
      }),
    ).rejects.toThrow(/wager_tx_single_reversal_uq/);
  });
});
