import { beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  createWallet,
  drainQueue,
  ensureSchema,
  eventually,
  expectConsistent,
  http,
  setupQueues,
  sql,
  startApp,
  submit,
  testConfig,
  transactionsOf,
  uniquePrefix,
  wagerBody,
} from '../support/harness';

/*
 * Tudo que importa sobrevive a um restart porque mora no PostgreSQL: resultados de
 * idempotência, referências pendentes e eventos não publicados. Nada fica em memória.
 */

beforeAll(ensureSchema);

describe('recovery after restart', () => {
  test('replays, pending references and unpublished events are picked up by the next instance', async () => {
    const prefix = uniquePrefix('restart');
    const apiOnly = testConfig(prefix, { APP_ROLES: 'api' });
    await setupQueues(apiOnly);

    // ---- instância 1: aceita trabalho, não publica nada, não resolve nada, e então para
    const first = await startApp(apiOnly);
    const { walletId, playerId } = await createWallet(first.url, '100.00');
    const bet = wagerBody({ walletId, playerId, kind: 'BET', amount: '30.00', externalTransactionId: `bet-${randomUUID()}` });
    const rollback = wagerBody({
      walletId,
      playerId,
      kind: 'ROLLBACK',
      amount: '30.00',
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const rollbackRes = await submit(first.url, rollback); // chega antes da sua BET
    expect(rollbackRes.status).toBe(202);
    const win = wagerBody({ walletId, playerId, kind: 'WIN', amount: '5.00' });
    const winRes = await submit(first.url, win);
    expect(winRes.status).toBe(201);
    await first.close();

    const unpublished = (await sql`SELECT id FROM outbox_messages WHERE aggregate_id = ${walletId} AND published_at IS NULL`) as unknown[];
    expect(unpublished.length).toBeGreaterThanOrEqual(5);

    // ---- instância 2: estado de processo novo (nenhuma memória compartilhada com a instância 1)
    const second = await startApp(testConfig(prefix));
    try {
      const replay = await submit(second.url, win);
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual({ ...winRes.body, idempotentReplay: true });

      expect((await submit(second.url, bet)).status).toBe(201);
      await eventually(
        () => transactionsOf(walletId),
        (txs) => txs.every((t) => t.status === 'PROCESSED'),
        15_000,
      );
      const rolledBack = await http(second.url, 'GET', `/wagering/transactions/${rollbackRes.body.transactionId}`);
      expect(rolledBack.body).toMatchObject({ status: 'PROCESSED', resultingBalance: { amount: '105.00' } });

      await eventually(
        async () => (await sql`SELECT id FROM outbox_messages WHERE aggregate_id = ${walletId} AND published_at IS NULL`).length,
        (n) => n === 0,
      );
      const all = ((await sql`SELECT id FROM outbox_messages WHERE aggregate_id = ${walletId}`) as Array<{ id: string }>).map((r) => r.id);
      const received = (await drainQueue(second.config, second.config.sqs.eventsQueueName, 1)).filter(
        (m) => m.body.aggregateId === walletId,
      );
      expect([...new Set(received.map((m) => m.body.eventId))].sort()).toEqual(all.sort());

      const state = await expectConsistent(walletId);
      expect(state.balance).toBe('105.00');
      const reconciliation = await http(second.url, 'POST', `/wallets/${walletId}/reconciliation`);
      expect(reconciliation.body.consistent).toBe(true);
    } finally {
      await second.close();
    }
  });
});
