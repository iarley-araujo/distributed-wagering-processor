import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ConfigurableFaultInjector } from '../../src/shared/infrastructure/fault-injector';
import {
  createWallet,
  ensureSchema,
  eventually,
  expectConsistent,
  sendToQueue,
  setupQueues,
  sql,
  startApp,
  submit,
  testConfig,
  type TestApp,
  transactionsOf,
  uniquePrefix,
  wagerBody,
  wagerMessage,
} from '../support/harness';

/*
 * Inbox + transação + ledger + wallet + outbox são uma transação SQL só. Uma falha no
 * último instante antes do COMMIT não pode deixar rastro em nenhum deles.
 */

const faults = new ConfigurableFaultInjector('');
let app: TestApp;

beforeAll(async () => {
  await ensureSchema();
  const config = testConfig(uniquePrefix('atomic'), { APP_ROLES: 'api,consumer', CONSUMER_MAX_ATTEMPTS: '10' });
  await setupQueues(config);
  app = await startApp(config, { faultInjector: faults });
});
afterAll(() => app?.close());

async function footprint(walletId: string, messageId?: string) {
  const [row] = (await sql`
    SELECT (SELECT count(*)::int FROM wager_transactions WHERE wallet_id = ${walletId} AND kind <> 'OPENING') AS transactions,
           (SELECT count(*)::int FROM wallet_ledger_entries WHERE wallet_id = ${walletId}) AS ledger,
           (SELECT count(*)::int FROM outbox_messages WHERE aggregate_id = ${walletId}) AS outbox,
           (SELECT count(*)::int FROM inbox_messages WHERE message_id = ${messageId ?? ''}) AS inbox,
           (SELECT balance::text FROM wallets WHERE id = ${walletId}) AS balance,
           (SELECT version FROM wallets WHERE id = ${walletId}) AS version`) as Array<Record<string, number | string>>;
  return row;
}

describe('atomicity', () => {
  test('HTTP: a failure right before COMMIT leaves wallet, ledger and outbox untouched', async () => {
    const { walletId, playerId } = await createWallet(app.url, '100.00');
    const before = await footprint(walletId);
    faults.set('process.beforeCommit', () => {
      throw new Error('crash just before commit');
    });
    const body = wagerBody({ walletId, playerId, kind: 'BET', amount: '60.00' });
    try {
      const res = await submit(app.url, body);
      expect(res.status).toBe(500);
    } finally {
      faults.set('process.beforeCommit', undefined);
    }
    expect(await footprint(walletId)).toEqual(before);

    // nada foi gravado, então o retry do provedor é um processamento de primeira vez
    const retry = await submit(app.url, body);
    expect(retry.status).toBe(201);
    expect(retry.body.idempotentReplay).toBe(false);
    const after = await footprint(walletId);
    expect(after).toMatchObject({ transactions: 1, ledger: 2, outbox: (before?.outbox as number) + 2, balance: '40.00', version: 2 });
    await expectConsistent(walletId);
  });

  test('SQS: the inbox row is rolled back together with the effects', async () => {
    const { walletId, playerId } = await createWallet(app.url, '100.00');
    const message = wagerMessage({ walletId, playerId, kind: 'BET', amount: '10.00' });
    const before = await footprint(walletId, message.messageId);
    let attempts = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    faults.set('process.beforeCommit', async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('crash just before commit');
      if (attempts === 2) {
        // Segunda tentativa: todas as linhas escritas mas não commitadas; seguro aqui e falho.
        await gate;
        throw new Error('crash just before commit');
      }
    });
    let afterFirstFailure: Awaited<ReturnType<typeof footprint>> | undefined;
    let duringUncommittedAttempt: Awaited<ReturnType<typeof footprint>> | undefined;
    try {
      await sendToQueue(app.config, app.config.sqs.wagerQueueName, message, walletId);
      await eventually(async () => attempts, (n) => n >= 2);
      afterFirstFailure = await footprint(walletId, message.messageId);
      duringUncommittedAttempt = await footprint(walletId, message.messageId);
      release();
      await eventually(() => transactionsOf(walletId), (t) => t.length === 1, 20_000);
    } finally {
      release();
      faults.set('process.beforeCommit', undefined);
    }
    expect(afterFirstFailure).toEqual(before);
    expect(duringUncommittedAttempt).toEqual(before);
    expect(attempts).toBe(3);
    expect(await footprint(walletId, message.messageId)).toMatchObject({ inbox: 1, transactions: 1, balance: '90.00' });
    await expectConsistent(walletId);
  });

  test('outbox rows exist if and only if the business change committed', async () => {
    const { walletId, playerId } = await createWallet(app.url, '5.00');
    await submit(app.url, wagerBody({ walletId, playerId, kind: 'BET', amount: '5.00' })); // processada
    await submit(app.url, wagerBody({ walletId, playerId, kind: 'BET', amount: '5.00' })); // rejeitada
    await submit(app.url, wagerBody({ walletId, playerId, kind: 'LOSS', amount: '5.00' })); // não muda o saldo
    const events = (await sql`SELECT event_type FROM outbox_messages WHERE aggregate_id = ${walletId} ORDER BY occurred_at, id`) as Array<{
      event_type: string;
    }>;
    expect(events.map((e) => e.event_type).sort()).toEqual(
      [
        'WagerTransactionProcessed', // abertura
        'WalletBalanceChanged', // abertura
        'WagerTransactionProcessed', // bet
        'WalletBalanceChanged', // bet
        'WagerTransactionRejected',
        'WagerTransactionProcessed', // loss: processada, mas sem WalletBalanceChanged
      ].sort(),
    );
  });
});
